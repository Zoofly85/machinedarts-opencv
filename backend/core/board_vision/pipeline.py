from __future__ import annotations

from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from itertools import combinations
from typing import Any

import cv2
import numpy as np

from .geometry import (
    BoardCalibration,
    line_intersection,
    point_distance,
    point_line_distance,
    score_point,
)
from .models import CameraVote, DetectionResult, IntersectionVote, Segment
from .rules import is_bouncer
from .vision import DiffParams, best_line, lowest_point, segment


MISS = Segment(0, 0, "Outside")
MAX_INTERSECTION_LINE_ERROR = 0.15
_CAMERA_EXECUTOR = ThreadPoolExecutor(max_workers=3, thread_name_prefix="dart-camera")


def _configured(item: dict[str, Any], key: str, default: Any) -> Any:
    value = item.get(key)
    return default if value is None else value


class BoardVisionDetector:
    def __init__(
        self,
        config: dict[str, Any],
        dynamic: list[dict[str, Any]] | None = None,
        *,
        segmentation_mode: str = "throw",
        parallel_cameras: bool = True,
        support_mode: str = "clip",
        hough_selection: str = "closest",
        diff_margins: tuple[int, int, int, int] = (0, 0, 0, 0),
        lowest_point_band: int = 3,
    ) -> None:
        self.config = config
        self.dynamic = dynamic or []
        self.segmentation_mode = segmentation_mode
        self.parallel_cameras = parallel_cameras
        self.support_mode = support_mode
        self.hough_selection = hough_selection
        self.diff_margins = diff_margins
        self.lowest_point_band = lowest_point_band
        dartboards = config.get("dartboard") or {}
        self.calibrations = {
            int(key): BoardCalibration.from_config(int(key), value)
            for key, value in dartboards.items()
        }
        detection = config.get("detection") or {}
        self.kernel = int(detection.get("kernel") or 5)
        self.threshold = int(detection.get("threshold") or 16)

    def _params(self, camera: int) -> tuple[DiffParams, int, int]:
        item = self.dynamic[camera] if camera < len(self.dynamic) else {}
        return (
            DiffParams(
                threshold=self.threshold,
                kernel=self.kernel,
                min_contour_area=float(
                    _configured(item, "detectionMinContourArea", 32.0)
                ),
                margins=self.diff_margins,
            ),
            int(_configured(item, "detectionHoughThreshold", 16)),
            int(_configured(item, "detectionMinNewPixels", 160)),
        )

    def _bouncer_params(self, camera: int) -> tuple[int, float]:
        item = self.dynamic[camera] if camera < len(self.dynamic) else {}
        return (
            int(_configured(item, "detectionMinNewPixels", 160)),
            float(_configured(item, "detectionMinNewDartPixelRatio", 0.6)),
        )

    def camera_vote(self, camera: int, empty: np.ndarray, before: np.ndarray, after: np.ndarray) -> CameraVote:
        calibration = self.calibrations[camera]
        params, hough_threshold, _ = self._params(camera)
        min_new_pixels, min_new_ratio = self._bouncer_params(camera)
        support = calibration.support_mask(after.shape)
        state = segment(
            empty,
            before,
            after,
            params,
            support,
            self.segmentation_mode,
            self.support_mode,
            self.lowest_point_band,
        )

        def count(mask: np.ndarray) -> int:
            if self.support_mode == "count_only":
                return int(np.count_nonzero(cv2.bitwise_and(mask, support)))
            return int(np.count_nonzero(mask))

        new_pixels = count(state.new)
        bouncer_new_mask = cv2.bitwise_or(
            cv2.bitwise_and(
                state.darts_after,
                cv2.bitwise_not(state.darts_before),
            ),
            cv2.bitwise_and(
                state.throw_diff,
                cv2.bitwise_not(state.darts_before),
            ),
        )
        bouncer_new_pixels = count(bouncer_new_mask)
        moved_pixels = count(state.moved)
        bouncer = is_bouncer(
            new_pixels=bouncer_new_pixels,
            moved_pixels=moved_pixels,
            min_new_pixels=min_new_pixels,
            min_new_ratio=min_new_ratio,
        )
        selected_pixels = int(np.count_nonzero(state.selected))
        tip = lowest_point(state.selected, self.lowest_point_band)
        debug = {
            "new_pixels": new_pixels,
            "bouncer_new_pixels": bouncer_new_pixels,
            "selected_pixels": selected_pixels,
            "stationary": count(state.stationary),
            "moved": moved_pixels,
            "old": count(state.old),
            "min_new_pixels": min_new_pixels,
            "min_new_ratio": min_new_ratio,
            "hough_threshold": hough_threshold,
        }
        if tip is None:
            return CameraVote(
                camera,
                True,
                MISS,
                mask_pixels=selected_pixels,
                selected_mask=state.selected,
                bouncer=bouncer,
                debug=debug,
            )
        board_tip = calibration.point(tip)
        tip_segment = score_point(board_tip)
        image_line, image_error, skeleton = best_line(
            state.selected,
            tip,
            hough_threshold,
            selection=self.hough_selection,
        )
        debug["skeleton_pixels"] = int(np.count_nonzero(skeleton))
        if image_line is None:
            return CameraVote(
                camera,
                False,
                tip_segment,
                image_tip=tip,
                board_tip=board_tip,
                error=1_000_000_000.0,
                mask_pixels=selected_pixels,
                selected_mask=state.selected,
                bouncer=bouncer,
                debug=debug,
            )
        board_line = calibration.line(image_line)
        board_error = point_line_distance(board_tip, board_line)
        return CameraVote(
            camera=camera,
            abstention=False,
            segment=score_point(board_tip),
            image_tip=tip,
            board_tip=board_tip,
            image_line=image_line,
            board_line=board_line,
            error=board_error,
            mask_pixels=selected_pixels,
            selected_mask=state.selected,
            bouncer=bouncer,
            debug={**debug, "image_line_error": image_error},
        )

    def detect(self, empty: dict[int, np.ndarray], before: dict[int, np.ndarray], after: dict[int, np.ndarray]) -> DetectionResult:
        camera_ids = [
            camera
            for camera in sorted(self.calibrations)
            if camera in empty and camera in before and camera in after
        ]
        if self.parallel_cameras and len(camera_ids) > 1:
            cameras = list(_CAMERA_EXECUTOR.map(
                lambda camera: self.camera_vote(
                    camera,
                    empty[camera],
                    before[camera],
                    after[camera],
                ),
                camera_ids,
            ))
        else:
            cameras = [
                self.camera_vote(camera, empty[camera], before[camera], after[camera])
                for camera in camera_ids
            ]
        intersections: list[IntersectionVote] = []
        for first, second in combinations(cameras, 2):
            if first.abstention or second.abstention or first.board_line is None or second.board_line is None:
                intersections.append(IntersectionVote(first.camera, second.camera, True, MISS))
                continue
            point = line_intersection(first.board_line, second.board_line)
            intersections.append(IntersectionVote(
                first.camera,
                second.camera,
                False,
                score_point(point),
                point,
                point_distance(point, first.board_tip) if first.board_tip else None,
                point_distance(point, second.board_tip) if second.board_tip else None,
            ))
        segment, method, coords = self._elect(cameras, intersections)
        aggregate_bouncer = bool(cameras) and all(vote.bouncer for vote in cameras)
        if aggregate_bouncer:
            segment = MISS
            coords = None
        return DetectionResult(
            segment,
            method,
            coords,
            cameras,
            intersections,
            aggregate_bouncer,
        )

    @staticmethod
    def _elect(
        cameras: list[CameraVote],
        intersections: list[IntersectionVote],
    ) -> tuple[Segment, str, tuple[float, float] | None]:
        usable_cameras = sorted(
            (
                vote
                for vote in cameras
                if not vote.abstention and not vote.bouncer
            ),
            key=lambda vote: vote.error if vote.error is not None else 999,
        )
        camera_labels = Counter(vote.segment.label for vote in usable_cameras)
        if len(usable_cameras) >= 3 and len(camera_labels) == 1:
            coords = tuple(
                np.median(
                    np.asarray([vote.board_tip for vote in usable_cameras], np.float64),
                    axis=0,
                ).tolist()
            )
            return usable_cameras[0].segment, "CameraConsensus", coords

        bouncer_cameras = {vote.camera for vote in cameras if vote.bouncer}
        usable_intersections = [
            item
            for item in intersections
            if not item.abstention
            and item.cam1 not in bouncer_cameras
            and item.cam2 not in bouncer_cameras
            and item.coords is not None
            and (item.cam1_error or float("inf")) <= MAX_INTERSECTION_LINE_ERROR
            and (item.cam2_error or float("inf")) <= MAX_INTERSECTION_LINE_ERROR
        ]
        by_label: dict[str, list[IntersectionVote]] = defaultdict(list)
        for item in usable_intersections:
            by_label[item.segment.label].append(item)
        if by_label:
            label, group = max(
                by_label.items(),
                key=lambda item: (
                    len(item[1]),
                    -sum(
                        (vote.cam1_error or 0) + (vote.cam2_error or 0)
                        for vote in item[1]
                    ),
                ),
            )
            if len(group) >= 2:
                coords = tuple(
                    np.median(
                        np.asarray([vote.coords for vote in group], np.float64),
                        axis=0,
                    ).tolist()
                )
                return group[0].segment, "IntersectionConsensus", coords
        if len(usable_cameras) == 1:
            vote = usable_cameras[0]
            return vote.segment, "BestCamera", vote.board_tip
        if not usable_cameras:
            return MISS, "Failed", None
        if camera_labels:
            label, count = camera_labels.most_common(1)[0]
            if count >= 2:
                chosen = [
                    vote for vote in usable_cameras
                    if vote.segment.label == label
                ]
                coords = tuple(
                    np.median(
                        np.asarray([vote.board_tip for vote in chosen], np.float64),
                        axis=0,
                    ).tolist()
                )
                return chosen[0].segment, "CameraConsensus", coords
        for item in sorted(
            usable_intersections,
            key=lambda vote: (
                (vote.cam1_error or 999) + (vote.cam2_error or 999)
            ),
        ):
            if camera_labels[item.segment.label] > 0:
                return item.segment, "Cam+Intersection", item.coords
        return (
            usable_cameras[0].segment,
            "BestCamera",
            usable_cameras[0].board_tip,
        )
