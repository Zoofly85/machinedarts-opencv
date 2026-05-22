#!/usr/bin/env python3
"""
Dartboard calibration system using homography transformation with rotation and persistence.
Based on proven homography approach for accurate perspective correction.
"""

import cv2
import numpy as np
import math
import os
import time
import json
from typing import Dict, Any, Tuple, List, Optional

from .ellipse_calibration import (
    EllipseCalibration,
    build_ellipse_calibration,
    calculate_ellipse_calibration_quality,
    draw_ellipse_overlay,
    line_ellipse_intersection,
    score_from_ellipse_calibration,
    segment_at_top,
)

# Inner calibration points are part of the normal calibration path now.
# Keep the env var only as an escape hatch if we ever need to disable them.
USE_INNER_CALIBRATION_POINTS = os.environ.get("DART_DETECTOR_USE_CAL2_CAL3", "1").lower() in (
    "1",
    "true",
    "yes",
)
FRONTON_DEBUG_LOGS = os.environ.get("DART_DETECTOR_FRONTON_DEBUG", "0").lower() in (
    "1",
    "true",
    "yes",
)

# Default dartboard settings (in mm)
DARTBOARD_SEGMENTS = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5]
DARTBOARD_RADIUS = 225.5
BULL_RADIUS = 6.35
OUTER_BULL_RADIUS = 15.9
TRIPLE_INNER_RADIUS = 98.0
TRIPLE_OUTER_RADIUS = 107.0
DOUBLE_INNER_RADIUS = 160.0
DOUBLE_OUTER_RADIUS = 170.0
SEGMENT_ANGLE_OFFSET = -math.pi / 2  # align segment 20 with 12 o'clock in model space


class DartboardCalibrator:
    def __init__(self, calibration_dir="."):
        """Initialize dartboard calibrator with homography approach and rotation support"""
        self.is_calibrated = False
        self.dartboard_center = None
        self.homography_matrix = None
        self.inverse_homography_matrix = None
        self.calibration_image = None
        self.calibration_quality = 0.0
        self.calibration_error_px = None
        self.calibration_quality_metric = "unknown"
        self.calibration_quality_details: Dict[str, Any] = {}
        self.homography_quality = 0.0
        self.homography_error_px = None
        self.calibration_dir = calibration_dir
        self.rotation_angle = 0.0  # Rotation angle in degrees
        self._rotation_manually_set = False
        self.fronton_offset = 0.0  # Additional offset for front-on view alignment
        self.homography_rotation_offset = 0.0  # Rotation introduced by homography
        self.detected_center_before_homography = None  # Camera-space center before homography
        self.ellipse_calibration: Optional[EllipseCalibration] = None
        
        # Create perfect dartboard model
        self.image_width = 1280
        self.image_height = 720
        self.model_center = (self.image_width // 2, self.image_height // 2)
        
        # Calculate pixel scale for the model (fit dartboard to image height)
        self.dartboard_diameter_mm = DOUBLE_OUTER_RADIUS * 2
        self.pixels_per_mm = (self.image_height * 0.8) / self.dartboard_diameter_mm
        
        # Convert dartboard dimensions to pixels for the model
        self.bull_radius_px = int(BULL_RADIUS * self.pixels_per_mm)
        self.outer_bull_radius_px = int(OUTER_BULL_RADIUS * self.pixels_per_mm)
        self.triple_inner_radius_px = int(TRIPLE_INNER_RADIUS * self.pixels_per_mm)
        self.triple_outer_radius_px = int(TRIPLE_OUTER_RADIUS * self.pixels_per_mm)
        self.double_inner_radius_px = int(DOUBLE_INNER_RADIUS * self.pixels_per_mm)
        self.double_outer_radius_px = int(DOUBLE_OUTER_RADIUS * self.pixels_per_mm)
        
        # Create reference dartboard model and intersection points
        self.spider_image, self.scoring_zones_image = self._create_dartboard_components()
        (
            self.dartboard_model,
            self.reference_double_points,
            self.reference_triple_points,
            self.reference_double_inner_points,
            self.reference_triple_inner_points,
        ) = self._create_dartboard_model()
        
        # Try to load existing calibration
        self.load_calibration()
        self._load_ellipse_calibration_json()
        
    def _create_dartboard_components(self):
        """Create separate spider and scoring zones images like the reference code"""
        # Create spider image (rings and lines)
        spider_image = np.ones((self.image_height, self.image_width, 3), dtype=np.uint8) * 255
        
        # Draw rings on spider
        cv2.circle(spider_image, self.model_center, self.bull_radius_px, (0, 0, 0), -1)  # Bull
        cv2.circle(spider_image, self.model_center, self.outer_bull_radius_px, (255, 0, 0), 2)  # Outer bull
        cv2.circle(spider_image, self.model_center, self.triple_inner_radius_px, (0, 255, 0), 2)  # Triple inner
        cv2.circle(spider_image, self.model_center, self.triple_outer_radius_px, (0, 255, 0), 2)  # Triple outer
        cv2.circle(spider_image, self.model_center, self.double_inner_radius_px, (0, 0, 255), 2)  # Double inner
        cv2.circle(spider_image, self.model_center, self.double_outer_radius_px, (0, 0, 255), 2)  # Double outer
        
        # Draw sector lines on spider
        angle_offset = SEGMENT_ANGLE_OFFSET  # ensure segment 20 (index 0) starts at 12 o'clock
        for i in range(20):
            angle = i * 2 * np.pi / 20 + angle_offset
            start_x = int(self.model_center[0] + np.cos(angle) * self.double_outer_radius_px)
            start_y = int(self.model_center[1] + np.sin(angle) * self.double_outer_radius_px)
            end_x = int(self.model_center[0] + np.cos(angle) * self.outer_bull_radius_px)
            end_y = int(self.model_center[1] + np.sin(angle) * self.outer_bull_radius_px)
            cv2.line(spider_image, (start_x, start_y), (end_x, end_y), (0, 0, 0), 1)
        
        # Create scoring zones image (segment numbers and special markings)
        # Use transparent/black background so overlay doesn't haze the camera feed
        scoring_zones_image = np.zeros((self.image_height, self.image_width, 3), dtype=np.uint8)
        
        # Highlight the 20 segment (ensure 20 at 12 o'clock)
        sector_20_angle_start = angle_offset
        sector_20_angle_end = angle_offset + 2 * np.pi / 20
        
        # Create polygon for 20 segment
        sector_20_points = [self.model_center]
        num_points = 20
        for i in range(num_points + 1):
            angle = sector_20_angle_start + (sector_20_angle_end - sector_20_angle_start) * i / num_points
            x = int(self.model_center[0] + np.cos(angle) * self.double_outer_radius_px)
            y = int(self.model_center[1] + np.sin(angle) * self.double_outer_radius_px)
            sector_20_points.append((x, y))
        
        sector_20_points = np.array(sector_20_points, dtype=np.int32)
        cv2.fillPoly(scoring_zones_image, [sector_20_points], (0, 255, 255))  # Yellow
        
        # Add segment numbers
        text_radius_px = int((self.triple_outer_radius_px + self.double_inner_radius_px) / 2)
        for i, score in enumerate(DARTBOARD_SEGMENTS):
            angle = i * 2 * np.pi / 20 + angle_offset
            text_x = int(self.model_center[0] + np.cos(angle) * text_radius_px)
            text_y = int(self.model_center[1] + np.sin(angle) * text_radius_px)
            
            font = cv2.FONT_HERSHEY_SIMPLEX
            font_scale = 1.0 if score == 20 else 0.6
            thickness = 2
            color = (0, 0, 255) if score == 20 else (0, 0, 0)
            
            text_size = cv2.getTextSize(str(score), font, font_scale, thickness)[0]
            text_origin = (text_x - text_size[0] // 2, text_y + text_size[1] // 2)
            cv2.putText(scoring_zones_image, str(score), text_origin, font, font_scale, color, thickness)
        
        return spider_image, scoring_zones_image
    
    def _create_dartboard_model(self):
        """Create a perfect dartboard model with reference intersection points"""
        # Combine spider and scoring zones
        model = self._combine_spider_and_scoring_zones(self.spider_image, self.scoring_zones_image)
        
        # Calculate reference intersection points
        reference_double_points = []
        reference_triple_points = []
        reference_double_inner_points = []
        reference_triple_inner_points = []
        angle_offset = SEGMENT_ANGLE_OFFSET
        for i in range(20):
            angle = i * 2 * np.pi / 20 + angle_offset
            
            # Double ring outer boundary (CAL points should map here)
            double_x = int(self.model_center[0] + np.cos(angle) * self.double_outer_radius_px)
            double_y = int(self.model_center[1] + np.sin(angle) * self.double_outer_radius_px)
            reference_double_points.append((double_x, double_y))
            
            # Double ring inner boundary (CAL3 points map here)
            double_inner_x = int(self.model_center[0] + np.cos(angle) * self.double_inner_radius_px)
            double_inner_y = int(self.model_center[1] + np.sin(angle) * self.double_inner_radius_px)
            reference_double_inner_points.append((double_inner_x, double_inner_y))
            
            # Triple ring outer boundary (CAL1 points should map here)
            triple_x = int(self.model_center[0] + np.cos(angle) * self.triple_outer_radius_px)
            triple_y = int(self.model_center[1] + np.sin(angle) * self.triple_outer_radius_px)
            reference_triple_points.append((triple_x, triple_y))
            
            # Triple ring inner boundary (CAL2 points map here)
            triple_inner_x = int(self.model_center[0] + np.cos(angle) * self.triple_inner_radius_px)
            triple_inner_y = int(self.model_center[1] + np.sin(angle) * self.triple_inner_radius_px)
            reference_triple_inner_points.append((triple_inner_x, triple_inner_y))
            
            # Mark intersection points on model
            cv2.circle(model, (double_x, double_y), 3, (0, 0, 255), -1)  # Red for double
            cv2.circle(model, (triple_x, triple_y), 3, (0, 165, 255), -1)  # Orange for triple
        
        return (
            model,
            reference_double_points,
            reference_triple_points,
            reference_double_inner_points,
            reference_triple_inner_points,
        )
    
    def _combine_spider_and_scoring_zones(self, spider_image, scoring_zones_image):
        """Combine spider and scoring zones images"""
        combined_image = scoring_zones_image.copy()
        spider_mask = cv2.cvtColor(spider_image, cv2.COLOR_BGR2GRAY) < 255
        combined_image[spider_mask] = spider_image[spider_mask]
        return combined_image
    
    def rotate_dartboard_model(self, angle_degrees):
        """Rotate only the scoring zones while keeping the spider fixed"""
        center = self.model_center
        rotation_matrix = cv2.getRotationMatrix2D(center, angle_degrees, 1)
        
        # Rotate only the scoring zones
        rotated_scoring_zones = cv2.warpAffine(
            self.scoring_zones_image, rotation_matrix,
            (self.image_width, self.image_height),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=(0, 0, 0)
        )
        
        # Combine with fixed spider
        rotated_model = self._combine_spider_and_scoring_zones(self.spider_image, rotated_scoring_zones)
        return rotated_model
    
    def set_rotation_angle(self, angle_degrees):
        """Set the rotation angle for scoring zones"""
        self.rotation_angle = angle_degrees % 360
        self._rotation_manually_set = True
        # Update the dartboard model with rotation
        self.dartboard_model = self.rotate_dartboard_model(self.rotation_angle)
    
    def set_fronton_offset(self, offset_degrees):
        """Set the front-on view offset angle"""
        self.fronton_offset = offset_degrees % 360
        # Save the calibration with the new offset
        self.save_calibration()
        print(f"Front-on offset set to {self.fronton_offset}°")
        print(f"Dartboard rotation set to {self.rotation_angle:.1f} degrees")
    
    def rotate_to_next_segment(self):
        """Rotate to the next segment (18 degrees counter-clockwise)"""
        current_segment = round(self.rotation_angle / 18) % 20
        next_segment = (current_segment + 1) % 20
        self.set_rotation_angle(next_segment * 18)
        return next_segment
    
    def rotate_to_previous_segment(self):
        """Rotate to the previous segment (18 degrees clockwise)"""
        current_segment = round(self.rotation_angle / 18) % 20
        prev_segment = (current_segment - 1) % 20
        self.set_rotation_angle(prev_segment * 18)
        return prev_segment
    
    def get_current_segment(self):
        """Get the current segment at the top (12 o'clock position)"""
        if self.ellipse_calibration is not None and self.ellipse_calibration.segment_angles:
            try:
                return segment_at_top(
                    self.ellipse_calibration.center,
                    self.ellipse_calibration.segment_angles,
                    rotation_offset_deg=float(self.rotation_angle),
                )
            except Exception:
                pass
        segment_index = round(self.rotation_angle / 18) % 20
        return DARTBOARD_SEGMENTS[segment_index]
        
    def capture_calibration(
        self,
        frame,
        cal_points,
        cal1_points,
        cal2_points=None,
        cal3_points=None,
        twenty_points=None,
        bull_boxes=None,
        bullseye_boxes=None,
    ):
        """
        Capture calibration using homography transformation
        
        Args:
            frame: Current camera frame
            cal_points: List of outer double ring intersection points [(x, y, conf), ...]
            cal1_points: List of triple ring intersection points [(x, y, conf), ...]
            cal2_points: List of triple inner ring points [(x, y, conf), ...]
            cal3_points: List of double inner ring points [(x, y, conf), ...]
            twenty_points: Optional list of "20" label points [(x, y, conf), ...] for auto-rotation
            
        Returns:
            bool: True if calibration successful, False otherwise
        """
        cal2_points_raw = list(cal2_points or [])
        cal3_points_raw = list(cal3_points or [])
        twenty_points = list(twenty_points or [])
        bull_boxes = list(bull_boxes or [])
        bullseye_boxes = list(bullseye_boxes or [])

        # Keep homography calibration behavior configurable, but don't throw away inner points for ellipse overlay.
        cal2_points = cal2_points_raw
        cal3_points = cal3_points_raw
        if not USE_INNER_CALIBRATION_POINTS:
            cal2_points = []
            cal3_points = []
        if len(cal_points) < 8 or len(cal1_points) < 8:
            print(f"Need at least 8 points each for homography: cal={len(cal_points)}, cal1={len(cal1_points)}")
            return False

        # Build ellipse calibration for better overlay + optional scoring.
        try:
            ellipse_cal = build_ellipse_calibration(
                cal_points,
                cal1_points,
                cal2_points_raw,
                cal3_points_raw,
                twenty_points=twenty_points,
                bull_boxes=bull_boxes,
                bullseye_boxes=bullseye_boxes,
            )
            if ellipse_cal is not None:
                self.ellipse_calibration = ellipse_cal
                if ellipse_cal.auto_rotation_offset_deg is not None:
                    # Always align rotation to the detected 20 marker when available.
                    self.rotation_angle = float(ellipse_cal.auto_rotation_offset_deg) % 360.0
                    self.dartboard_model = self.rotate_dartboard_model(self.rotation_angle)
                    self._rotation_manually_set = False
                    print(f"[OK] Auto-rotation from YOLO '20': {self.rotation_angle:.1f} deg")
        except Exception as e:
            print(f"[WARN] Ellipse calibration build failed: {e}")
        
        # Store calibration image
        self.calibration_image = frame.copy()
        
        # Perform homography-based calibration
        success = self.calibrate_with_homography(cal_points, cal1_points, cal2_points, cal3_points)

        if success and self.ellipse_calibration is not None:
            try:
                quality_details = calculate_ellipse_calibration_quality(
                    self.ellipse_calibration,
                    cal_points,
                    cal1_points,
                    cal2_points_raw,
                    cal3_points_raw,
                )
                self.calibration_quality = float(quality_details.get("quality", self.calibration_quality))
                self.calibration_error_px = quality_details.get("combined_error_px")
                self.calibration_quality_metric = str(quality_details.get("metric", "ellipse_radial_fit"))
                self.calibration_quality_details = quality_details
                ring_err = quality_details.get("ring_error_px")
                radial_err = quality_details.get("radial_error_px")
                print(
                    f"Ellipse/radial calibration quality: {self.calibration_quality:.2f} "
                    f"(ring={ring_err:.2f}px, radial={radial_err:.2f}px)"
                    if ring_err is not None and radial_err is not None
                    else f"Ellipse/radial calibration quality: {self.calibration_quality:.2f}"
                )
            except Exception as e:
                print(f"[WARN] Ellipse/radial quality calculation failed: {e}")
        
        if success:
            # Save calibration automatically
            self.save_calibration()
        
        return success
        
    def calibrate_with_homography(self, cal_points, cal1_points, cal2_points=None, cal3_points=None):
        """
        Calibrate dartboard using homography transformation with improved angular matching
        for better spider fitting (based on reference implementation)
        
        Args:
            cal_points: List of outer double ring intersection points [(x, y, conf), ...]
            cal1_points: List of triple ring intersection points [(x, y, conf), ...]
            cal2_points: List of triple inner ring points [(x, y, conf), ...]
            cal3_points: List of double inner ring points [(x, y, conf), ...]
            
        Returns:
            bool: True if calibration successful, False otherwise
        """
        try:
            cal2_points = cal2_points or []
            cal3_points = cal3_points or []
            if not USE_INNER_CALIBRATION_POINTS:
                cal2_points = []
                cal3_points = []
            # Extract coordinates and sort by confidence
            cal_coords = [(x, y, conf) for x, y, conf in cal_points]
            cal1_coords = [(x, y, conf) for x, y, conf in cal1_points]
            cal2_coords = [(x, y, conf) for x, y, conf in cal2_points]
            cal3_coords = [(x, y, conf) for x, y, conf in cal3_points]
            
            # Sort by confidence (highest first) to prioritize best detections
            cal_coords.sort(key=lambda x: x[2], reverse=True)
            cal1_coords.sort(key=lambda x: x[2], reverse=True)
            cal2_coords.sort(key=lambda x: x[2], reverse=True)
            cal3_coords.sort(key=lambda x: x[2], reverse=True)
            
            # Extract just coordinates
            cal_points_sorted = [(x, y) for x, y, _ in cal_coords]
            cal1_points_sorted = [(x, y) for x, y, _ in cal1_coords]
            cal2_points_sorted = [(x, y) for x, y, _ in cal2_coords]
            cal3_points_sorted = [(x, y) for x, y, _ in cal3_coords]
            
            # Calculate approximate center from detected points
            all_points = cal_points_sorted + cal1_points_sorted + cal2_points_sorted + cal3_points_sorted
            center_x = sum(p[0] for p in all_points) / len(all_points)
            center_y = sum(p[1] for p in all_points) / len(all_points)
            detected_center = (center_x, center_y)
            
            # Store the detected center for later use
            self.detected_center_before_homography = detected_center
            
            # IMPROVED: Sort points by angle around the detected center (like reference code)
            # This preserves angular correspondence for better spider fitting
            cal_points_by_angle = self._sort_points_by_angle(cal_points_sorted, detected_center)
            cal1_points_by_angle = self._sort_points_by_angle(cal1_points_sorted, detected_center)
            cal2_points_by_angle = self._sort_points_by_angle(cal2_points_sorted, detected_center)
            cal3_points_by_angle = self._sort_points_by_angle(cal3_points_sorted, detected_center)
            
            # Store the first point's angle for front-on offset calculation
            if len(cal_points_by_angle) > 0:
                first_point = cal_points_by_angle[0]
                first_point_angle = math.atan2(first_point[1] - detected_center[1],
                                              first_point[0] - detected_center[0])
                self.first_detected_point_angle_deg = math.degrees(first_point_angle)
                print(f"First detected point angle: {self.first_detected_point_angle_deg:.1f}°")
            
            # IMPROVED: Use direct angular matching instead of segment distribution
            # Take up to 20 points in angular order to match reference points in angular order
            # This ensures detected point at angle X maps to reference point at angle X
            cal_selected = cal_points_by_angle[:min(len(cal_points_by_angle), 20)]
            cal1_selected = cal1_points_by_angle[:min(len(cal1_points_by_angle), 20)]
            cal2_selected = cal2_points_by_angle[:min(len(cal2_points_by_angle), 20)]
            cal3_selected = cal3_points_by_angle[:min(len(cal3_points_by_angle), 20)]

            print(
                f"Selected {len(cal_selected)} CAL points, {len(cal1_selected)} CAL1 points, "
                f"{len(cal2_selected)} CAL2 points, {len(cal3_selected)} CAL3 points for homography"
            )
            print(f"Using angular matching for improved spider fitting")
            
            # Create source points (detected) and destination points (model)
            src_points = []
            dst_points = []
            
            # Add double ring points (CAL -> reference double points)
            # Match in angular order: detected[0] -> reference[0], detected[1] -> reference[1], etc.
            num_double = min(len(cal_selected), len(self.reference_double_points))
            for i in range(num_double):
                src_points.append(cal_selected[i])
                dst_points.append(self.reference_double_points[i])
            
            # Add triple ring points (CAL1 -> reference triple points)
            # Match in angular order for consistent spider alignment
            num_triple = min(len(cal1_selected), len(self.reference_triple_points))
            for i in range(num_triple):
                src_points.append(cal1_selected[i])
                dst_points.append(self.reference_triple_points[i])

            # Add triple inner ring points (CAL2 -> reference triple inner points)
            num_triple_inner = min(len(cal2_selected), len(self.reference_triple_inner_points))
            for i in range(num_triple_inner):
                src_points.append(cal2_selected[i])
                dst_points.append(self.reference_triple_inner_points[i])

            # Add double inner ring points (CAL3 -> reference double inner points)
            num_double_inner = min(len(cal3_selected), len(self.reference_double_inner_points))
            for i in range(num_double_inner):
                src_points.append(cal3_selected[i])
                dst_points.append(self.reference_double_inner_points[i])
            
            if len(src_points) < 4:
                print("Not enough points for homography calculation")
                return False
            
            # Convert to numpy arrays
            src_points = np.array(src_points, dtype=np.float32)
            dst_points = np.array(dst_points, dtype=np.float32)
            
            # Calculate homography with RANSAC for robustness
            self.homography_matrix, status = cv2.findHomography(
                src_points, dst_points, cv2.RANSAC, 5.0
            )
            
            if self.homography_matrix is None:
                print("Failed to calculate homography matrix")
                return False
            
            # Calculate inverse homography for coordinate transformation
            self.inverse_homography_matrix = np.linalg.inv(self.homography_matrix)
            
            # Set dartboard center to model center
            self.dartboard_center = self.model_center
            
            # Keep legacy homography quality only as a fallback/diagnostic.
            self.homography_quality = self._calculate_homography_quality(src_points, dst_points)
            if self.ellipse_calibration is None:
                self.calibration_quality = float(self.homography_quality)
                self.calibration_error_px = self.homography_error_px
                self.calibration_quality_metric = "homography_reprojection"
                self.calibration_quality_details = {
                    "metric": "homography_reprojection",
                    "quality": float(self.homography_quality),
                    "combined_error_px": self.homography_error_px,
                }
            
            # Measure the camera-side angle of the 20 segment so we can later rotate to 12 o'clock
            self._update_camera_orientation_metadata("Calibration")
            
            print(f"Homography calibration successful!")
            print(
                f"Used {len(src_points)} points "
                f"({num_double} double outer, {num_triple} triple outer, "
                f"{num_triple_inner} triple inner, {num_double_inner} double inner)"
            )
            print(f"Homography quality (legacy): {self.homography_quality:.2f}")
            
            self.is_calibrated = True
            return True
            
        except Exception as e:
            print(f"Homography calibration error: {e}")
            return False
    
    def save_calibration(self):
        """Save calibration data to file"""
        try:
            # Apply any pending rotation to the persisted front-on offset
            # In ellipse-calibration mode, rotation_angle is the camera-space scoring-zone rotation and should be
            # persisted directly (do not fold into fronton_offset like the homography-only flow).
            if self.ellipse_calibration is None and abs(self.rotation_angle) > 1e-6:
                combined_offset = (self.fronton_offset + self.rotation_angle) % 360
                print(
                    f"Applying pending rotation {self.rotation_angle:.1f}° to front-on offset "
                    f"(previous {self.fronton_offset:.1f}° → new {combined_offset:.1f}°)"
                )
                self.fronton_offset = combined_offset
                self.rotation_angle = 0.0
                # Reset the dartboard model to match the new baseline orientation
                self.dartboard_model = self.rotate_dartboard_model(self.rotation_angle)
                # Update the camera orientation metadata to reflect the new rotation
                self._update_camera_orientation_metadata("Save with rotation")

            # Save ellipse calibration JSON (camera-space overlay/scoring).
            if self.ellipse_calibration is not None:
                json_path = os.path.join(self.calibration_dir, "dartboard_calibration.json")
                payload = {
                    "version": "2.0",
                    "format": "ellipse+homography",
                    "rotation_angle": float(self.rotation_angle),
                    "fronton_offset": float(self.fronton_offset),
                    "calibration_quality": float(self.calibration_quality),
                    "calibration_error_px": float(self.calibration_error_px) if self.calibration_error_px is not None else None,
                    "calibration_quality_metric": str(self.calibration_quality_metric),
                    "quality_details": self.calibration_quality_details,
                    "homography_quality": float(self.homography_quality),
                    "homography_error_px": float(self.homography_error_px) if self.homography_error_px is not None else None,
                    "ellipse": self.ellipse_calibration.to_json(),
                }
                with open(json_path, "w", encoding="utf-8") as f:
                    json.dump(payload, f, indent=2)
                print(f"Ellipse calibration saved to {json_path}")

            # Save homography calibration (legacy/compatibility + front-on view).
            if self.homography_matrix is not None:
                filename = os.path.join(self.calibration_dir, 'dartboard_calibration.npz')
                data_to_save = {
                    'homography_matrix': self.homography_matrix,
                    'rotation_angle': np.array(self.rotation_angle, dtype=np.float32),
                    'fronton_offset': np.array(self.fronton_offset, dtype=np.float32),
                    'calibration_quality': np.array(self.calibration_quality, dtype=np.float32),
                    'calibration_error_px': np.array(self.calibration_error_px if self.calibration_error_px is not None else -1.0, dtype=np.float32),
                    'homography_quality': np.array(self.homography_quality, dtype=np.float32),
                    'homography_error_px': np.array(self.homography_error_px if self.homography_error_px is not None else -1.0, dtype=np.float32),
                    'dartboard_center': np.array(self.dartboard_center, dtype=np.float32) if self.dartboard_center is not None else np.array([])
                }
                
                # Persist orientation metadata so the 20 segment can be restored at 12 o'clock
                data_to_save['homography_rotation_offset'] = np.array(self.homography_rotation_offset, dtype=np.float32)
                if self.detected_center_before_homography is not None:
                    data_to_save['detected_center_before_homography'] = np.array(self.detected_center_before_homography, dtype=np.float32)
                
                np.savez(filename, **data_to_save)
                print(f"Calibration saved to {filename}")

            # Persist a visual reference frame from calibration so replay/background
            # can use a stable "empty board" image until recalibration.
            if self.calibration_image is not None:
                ref_path = os.path.join(self.calibration_dir, "calibration_reference.jpg")
                ok = cv2.imwrite(ref_path, self.calibration_image)
                if ok:
                    print(f"Calibration reference image saved to {ref_path}")
                else:
                    print(f"[WARN] Failed to save calibration reference image: {ref_path}")
            return True
        except Exception as e:
            print(f"Error saving calibration: {e}")
            return False

    def _load_ellipse_calibration_json(self) -> bool:
        json_path = os.path.join(self.calibration_dir, "dartboard_calibration.json")
        if not os.path.exists(json_path):
            return False
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                payload = json.load(f)
            ellipse_data = payload.get("ellipse")
            if ellipse_data:
                self.ellipse_calibration = EllipseCalibration.from_json(ellipse_data)
                self.is_calibrated = True
            if "rotation_angle" in payload:
                self.rotation_angle = float(payload["rotation_angle"]) % 360.0
            if "fronton_offset" in payload:
                self.fronton_offset = float(payload["fronton_offset"]) % 360.0
            if "calibration_quality" in payload:
                self.calibration_quality = float(payload["calibration_quality"])
            self.calibration_error_px = (
                float(payload["calibration_error_px"]) if payload.get("calibration_error_px") is not None else self.calibration_error_px
            )
            self.calibration_quality_metric = str(payload.get("calibration_quality_metric", self.calibration_quality_metric))
            if isinstance(payload.get("quality_details"), dict):
                self.calibration_quality_details = dict(payload["quality_details"])
            if payload.get("homography_quality") is not None:
                self.homography_quality = float(payload["homography_quality"])
            if payload.get("homography_error_px") is not None:
                self.homography_error_px = float(payload["homography_error_px"])
            self.dartboard_model = self.rotate_dartboard_model(self.rotation_angle)
            print(f"Loaded ellipse calibration from {json_path}")
            return True
        except Exception as e:
            print(f"Failed to load ellipse calibration JSON: {e}")
            return False
    
    def load_calibration(self):
        """Load calibration data from file"""
        try:
            filename = os.path.join(self.calibration_dir, 'dartboard_calibration.npz')
            if not os.path.exists(filename):
                return False
            
            data = np.load(filename)
            self.homography_matrix = data['homography_matrix']
            self.inverse_homography_matrix = np.linalg.inv(self.homography_matrix)
            self.rotation_angle = float(data['rotation_angle'])
            self.fronton_offset = float(data['fronton_offset']) if 'fronton_offset' in data else 0.0
            self.calibration_quality = float(data['calibration_quality'])
            self.calibration_error_px = (
                float(data['calibration_error_px']) if 'calibration_error_px' in data and float(data['calibration_error_px']) >= 0 else None
            )
            self.homography_quality = float(data['homography_quality']) if 'homography_quality' in data else self.calibration_quality
            self.homography_error_px = (
                float(data['homography_error_px']) if 'homography_error_px' in data and float(data['homography_error_px']) >= 0 else None
            )
            if self.calibration_quality_metric == "unknown":
                self.calibration_quality_metric = "homography_reprojection"
            
            dartboard_center = data['dartboard_center'] if 'dartboard_center' in data else None
            if dartboard_center is not None and dartboard_center.size == 2:
                self.dartboard_center = (float(dartboard_center[0]), float(dartboard_center[1]))
            else:
                self.dartboard_center = self.model_center
            
            if 'detected_center_before_homography' in data:
                detected_center = data['detected_center_before_homography']
                if detected_center.size == 2:
                    self.detected_center_before_homography = (float(detected_center[0]), float(detected_center[1]))
                else:
                    self.detected_center_before_homography = None
            else:
                self.detected_center_before_homography = None
            
            if 'homography_rotation_offset' in data:
                self.homography_rotation_offset = float(data['homography_rotation_offset'])
            else:
                self._update_camera_orientation_metadata("Calibration load")
            
            # Update dartboard model with loaded rotation
            self.dartboard_model = self.rotate_dartboard_model(self.rotation_angle)
            
            self.is_calibrated = True
            print(f"Calibration loaded from {filename}")
            print(
                f"Rotation angle: {self.rotation_angle:.1f}°, "
                f"Quality: {self.calibration_quality:.2f} ({self.calibration_quality_metric})"
            )
            return True
            
        except Exception as e:
            print(f"Error loading calibration: {e}")
            return False
    
    def _sort_points_by_angle(self, points, center):
        """Sort points by angle around center"""
        def get_angle(point):
            return math.atan2(point[1] - center[1], point[0] - center[0])
        
        points_with_angles = [(point, get_angle(point)) for point in points]
        points_with_angles.sort(key=lambda x: x[1])
        return [point for point, angle in points_with_angles]
    
    def _calculate_homography_quality(self, src_points, dst_points):
        """Calculate quality based on reprojection error."""
        try:
            # Transform source points using homography
            transformed_points = cv2.perspectiveTransform(
                src_points.reshape(-1, 1, 2), self.homography_matrix
            ).reshape(-1, 2)
            
            # Calculate reprojection error (pixels)
            errors = np.linalg.norm(transformed_points - dst_points, axis=1)
            mean_error = float(np.mean(errors))
            
            # Cache raw error for diagnostics
            self.homography_error_px = mean_error
            
            # Dynamic tolerance: more forgiving (≈25% of double outer radius), min 20px
            tol_px = max(20.0, 0.25 * float(self.double_outer_radius_px))
            
            # Scale error into [0,1]; clamp to avoid negatives
            quality = max(0.0, min(1.0, 1.0 - (mean_error / tol_px)))
            return quality
        except Exception as e:
            print(f"Error computing homography quality: {e}")
            self.homography_error_px = None
            return 0.0
    
    def _get_segment_center_model_point(self, segment_number: int) -> Tuple[float, float]:
        """Return the model-space coordinates of the center of a dartboard segment."""
        if segment_number not in DARTBOARD_SEGMENTS:
            return self.model_center
        
        segment_index = DARTBOARD_SEGMENTS.index(segment_number)
        angle = segment_index * 2 * math.pi / len(DARTBOARD_SEGMENTS) + SEGMENT_ANGLE_OFFSET
        
        # Apply current rotation (rotating scoring_zones counter-clockwise in degrees)
        rotation_radians = math.radians(self.rotation_angle)
        angle -= rotation_radians
        
        radius = (self.triple_outer_radius_px + self.double_inner_radius_px) / 2.0
        x = self.model_center[0] + math.cos(angle) * radius
        y = self.model_center[1] + math.sin(angle) * radius
        return (x, y)
    
    def _calculate_segment_camera_angle(self, segment_number: int) -> Optional[float]:
        """Calculate the camera-space angle (0°=right, 90°=down) of a segment center."""
        if self.inverse_homography_matrix is None:
            return None
        
        segment_point = self._get_segment_center_model_point(segment_number)
        camera_point = self.transform_point_to_camera(segment_point)
        if camera_point is None:
            return None
        
        # Prefer the transformed model center for camera center reference
        camera_center = self.transform_point_to_camera(self.model_center)
        if camera_center is not None:
            self.detected_center_before_homography = (
                float(camera_center[0]),
                float(camera_center[1])
            )
        elif self.detected_center_before_homography is not None:
            camera_center = self.detected_center_before_homography
        else:
            camera_center = self.model_center
        
        angle_rad = math.atan2(
            camera_point[1] - camera_center[1],
            camera_point[0] - camera_center[0]
        )
        return (math.degrees(angle_rad) + 360) % 360

    def _calculate_twenty_camera_angle(self) -> Optional[float]:
        """Calculate the camera-space angle from bull center to detected 20 marker."""
        if self.ellipse_calibration is None:
            return None
        twenty_point = getattr(self.ellipse_calibration, "twenty_point", None)
        center = getattr(self.ellipse_calibration, "center", None)
        if not twenty_point or not center:
            return None
        try:
            tx, ty = float(twenty_point[0]), float(twenty_point[1])
            cx, cy = float(center[0]), float(center[1])
        except Exception:
            return None
        angle_rad = math.atan2(ty - cy, tx - cx)
        return (math.degrees(angle_rad) + 360) % 360

    def _calculate_twenty_center_angle_warped(self, homography: np.ndarray) -> Optional[float]:
        """Calculate the 20 segment center angle in warped (front-on) space."""
        calib = self.ellipse_calibration
        if calib is None or not calib.segment_angles or homography is None:
            return None
        if calib.outer_double_ellipse is None or calib.bull_ellipse is None:
            return None

        angles = [float(a) for a in calib.segment_angles]
        if not angles:
            return None
        rotation_steps = int(round(float(self.rotation_angle) / 18.0)) % 20
        n = len(angles)
        for idx, ang in enumerate(angles):
            seg_idx = (idx - rotation_steps) % 20
            if DARTBOARD_SEGMENTS[seg_idx] != 20:
                continue
            a0 = float(ang)
            a1 = float(angles[(idx + 1) % n])
            if a1 < a0:
                a1 += 360.0
            mid = (a0 + a1) / 2.0

            # Build a point along the mid-angle on the outer double ellipse.
            rad = math.radians(mid)
            dx, dy = float(math.cos(rad)), float(math.sin(rad))
            try:
                edge_pt = line_ellipse_intersection(calib.center, (dx, dy), calib.outer_double_ellipse)
            except Exception:
                return None

            center_pt = np.array([[calib.center]], dtype=np.float32)
            edge_pt_arr = np.array([[edge_pt]], dtype=np.float32)
            warped_center = cv2.perspectiveTransform(center_pt, homography)[0][0]
            warped_edge = cv2.perspectiveTransform(edge_pt_arr, homography)[0][0]

            angle_rad = math.atan2(warped_edge[1] - warped_center[1], warped_edge[0] - warped_center[0])
            return (math.degrees(angle_rad) + 360) % 360
        return None

    def _calculate_twenty_mid_angle_warped(self, homography: np.ndarray) -> Optional[float]:
        """Use the boundary interval containing the detected 20 point and return its midpoint angle in warped space."""
        calib = self.ellipse_calibration
        if calib is None or homography is None:
            return None
        if not calib.segment_angles or calib.outer_double_ellipse is None:
            return None
        if calib.twenty_point is None or calib.center is None:
            return None

        try:
            dx = float(calib.twenty_point[0]) - float(calib.center[0])
            dy = float(calib.twenty_point[1]) - float(calib.center[1])
        except Exception:
            return None

        angle_to_20 = (math.degrees(math.atan2(dy, dx)) + 360.0) % 360.0
        angles = [float(a) for a in calib.segment_angles]
        if not angles:
            return None
        angles_sorted = angles
        n = len(angles_sorted)

        chosen_mid = None
        for i in range(n):
            a0 = angles_sorted[i]
            a1 = angles_sorted[(i + 1) % n]
            if a1 < a0:
                a1 += 360.0
            a_test = angle_to_20
            if a_test < a0:
                a_test += 360.0
            if a0 <= a_test < a1:
                chosen_mid = (a0 + a1) / 2.0
                break

        if chosen_mid is None:
            return None

        rad = math.radians(chosen_mid)
        try:
            edge_pt = line_ellipse_intersection(
                calib.center, (float(math.cos(rad)), float(math.sin(rad))), calib.outer_double_ellipse
            )
        except Exception:
            return None

        center_pt = np.array([[calib.center]], dtype=np.float32)
        edge_pt_arr = np.array([[edge_pt]], dtype=np.float32)
        warped_center = cv2.perspectiveTransform(center_pt, homography)[0][0]
        warped_edge = cv2.perspectiveTransform(edge_pt_arr, homography)[0][0]

        angle_rad = math.atan2(warped_edge[1] - warped_center[1], warped_edge[0] - warped_center[0])
        return (math.degrees(angle_rad) + 360.0) % 360.0
    
    def _update_camera_orientation_metadata(self, reason="calibration"):
        """
        Update the stored camera-space angle of the 20 segment so we can rotate the
        front-on view to 12 o'clock regardless of camera placement.
        """
        angle_deg = self._calculate_segment_camera_angle(20)
        if angle_deg is None:
            self.homography_rotation_offset = 0.0
            return False
        
        self.homography_rotation_offset = angle_deg
        print(f"{reason}: 20 segment appears at {angle_deg:.1f} deg in camera space (0 deg=right, 90 deg=down)")
        return True
    
    def transform_point_to_model(self, point):
        """Transform a point from camera coordinates to model coordinates"""
        if self.homography_matrix is None:
            return point
        
        try:
            point_array = np.array([[point]], dtype=np.float32)
            transformed = cv2.perspectiveTransform(point_array, self.homography_matrix)
            return tuple(transformed[0][0])
        except:
            return point
    
    def transform_point_to_camera(self, point):
        """Transform a point from model coordinates to camera coordinates"""
        if self.inverse_homography_matrix is None:
            return point
        
        try:
            point_array = np.array([[point]], dtype=np.float32)
            transformed = cv2.perspectiveTransform(point_array, self.inverse_homography_matrix)
            return tuple(transformed[0][0])
        except:
            return point
    
    def calculate_score_with_rotation(self, dart_x, dart_y):
        """Calculate score with rotation adjustment like the reference code"""
        if not self.is_calibrated:
            return {'score': 0, 'multiplier': 1, 'segment': 0, 'zone': 'unknown'}
        
        # Transform dart position to model coordinates
        model_x, model_y = self.transform_point_to_model((dart_x, dart_y))
        
        # Calculate distance from model center
        distance = math.sqrt((model_x - self.model_center[0])**2 + (model_y - self.model_center[1])**2)
        
        # Calculate angle
        angle = math.atan2(model_y - self.model_center[1], model_x - self.model_center[0])
        
        # Adjust angle based on total rotation (fronton_offset + rotation_angle)
        total_rotation = self.fronton_offset + self.rotation_angle
        rotation_angle_radians = math.radians(total_rotation)
        adjusted_angle = angle - SEGMENT_ANGLE_OFFSET + rotation_angle_radians
        
        # Normalize adjusted angle
        while adjusted_angle < 0:
            adjusted_angle += 2 * math.pi
        while adjusted_angle >= 2 * math.pi:
            adjusted_angle -= 2 * math.pi
        
        # Determine segment based on adjusted angle
        segment_index = int(adjusted_angle / (2 * math.pi) * 20)
        if segment_index >= 20:
            segment_index = 0
        
        segment_number = DARTBOARD_SEGMENTS[segment_index]
        
        # Determine zone based on distance
        if distance <= self.bull_radius_px:
            return {'score': 50, 'multiplier': 1, 'segment': 0, 'zone': 'inner_bull'}
        elif distance <= self.outer_bull_radius_px:
            return {'score': 25, 'multiplier': 1, 'segment': 0, 'zone': 'outer_bull'}
        elif distance <= self.triple_inner_radius_px:
            return {'score': segment_number, 'multiplier': 1, 'segment': segment_number, 'zone': 'single_inner'}
        elif distance <= self.triple_outer_radius_px:
            return {'score': segment_number * 3, 'multiplier': 3, 'segment': segment_number, 'zone': 'triple'}
        elif distance <= self.double_inner_radius_px:
            return {'score': segment_number, 'multiplier': 1, 'segment': segment_number, 'zone': 'single_outer'}
        elif distance <= self.double_outer_radius_px:
            return {'score': segment_number * 2, 'multiplier': 2, 'segment': segment_number, 'zone': 'double'}
        else:
            return {'score': 0, 'multiplier': 1, 'segment': 0, 'zone': 'miss'}
    
    def get_dart_score(self, dart_x, dart_y):
        """Calculate score for a dart at given coordinates (with rotation support)"""
        if self.ellipse_calibration is not None and self.ellipse_calibration.outer_double_ellipse is not None:
            try:
                return score_from_ellipse_calibration(
                    (float(dart_x), float(dart_y)),
                    self.ellipse_calibration,
                    rotation_offset_deg=float(self.rotation_angle),
                )
            except Exception:
                pass
        return self.calculate_score_with_rotation(dart_x, dart_y)
    
    def get_fronton_view(self, frame):
        """
        Create a front-on view of the dartboard (like looking straight at it)
        with the 20 segment centered at 12 o'clock position, similar to reference code.
        
        Args:
            frame: Input camera frame
            
        Returns:
            numpy.ndarray: Transformed front-on view with dartboard overlay
        """
        if not self.is_calibrated or self.homography_matrix is None:
            return frame
        
        try:
            # Use a larger output size for homography to capture the full dartboard
            # The homography might warp the dartboard beyond the standard frame size
            scale_factor = 1.5  # 50% larger to ensure we capture everything
            large_width = int(self.image_width * scale_factor)
            large_height = int(self.image_height * scale_factor)
            
            # Adjust homography matrix to account for the larger output size
            # We need to translate the output to center it in the larger frame
            offset_x = (large_width - self.image_width) / 2
            offset_y = (large_height - self.image_height) / 2
            
            # Create translation matrix
            translation_matrix = np.array([
                [1, 0, offset_x],
                [0, 1, offset_y],
                [0, 0, 1]
            ], dtype=np.float32)
            
            # Combine translation with homography
            adjusted_homography = translation_matrix @ self.homography_matrix
            
            # Transform the camera frame to match the dartboard model (front-on view)
            # Use the larger output size to avoid cutting off the dartboard
            transformed_frame = cv2.warpPerspective(
                frame, adjusted_homography,
                (large_width, large_height)
            )
            
            # Rotate front-on view so the bull->20 line aligns with 12 o'clock.
            # Resolve bull center in warped space for angle calculations.
            center_src = None
            if self.ellipse_calibration is not None and self.ellipse_calibration.center is not None:
                center_src = self.ellipse_calibration.center
            elif self.detected_center_before_homography is not None:
                center_src = self.detected_center_before_homography
            else:
                center_src = self.model_center

            try:
                center_arr = np.array([[center_src]], dtype=np.float32)
                warped_center = cv2.perspectiveTransform(center_arr, adjusted_homography)[0][0]
                center_pt = (float(warped_center[0]), float(warped_center[1]))
            except Exception:
                center_pt = (float(self.model_center[0] + offset_x), float(self.model_center[1] + offset_y))

            # Use calibration bull->20 line in warped space.
            actual_twenty_angle = None
            warped_twenty = None
            if self.ellipse_calibration is not None and self.ellipse_calibration.twenty_point is not None:
                try:
                    tp = self.ellipse_calibration.twenty_point
                    twenty_arr = np.array([[(float(tp[0]), float(tp[1]))]], dtype=np.float32)
                    warped_twenty = cv2.perspectiveTransform(twenty_arr, adjusted_homography)[0][0]
                    actual_twenty_angle = math.degrees(
                        math.atan2(warped_twenty[1] - center_pt[1], warped_twenty[0] - center_pt[0])
                    ) % 360.0
                except Exception:
                    warped_twenty = None

            if actual_twenty_angle is None:
                actual_twenty_angle = self._calculate_twenty_center_angle_warped(adjusted_homography)
            if actual_twenty_angle is None:
                actual_twenty_angle = self._calculate_twenty_mid_angle_warped(adjusted_homography)
            if actual_twenty_angle is None:
                actual_twenty_angle = self._calculate_segment_camera_angle(20)
            if actual_twenty_angle is None:
                actual_twenty_angle = (self.homography_rotation_offset + self.rotation_angle) % 360
                if FRONTON_DEBUG_LOGS:
                    print(
                        f"[Calibration] No 20-point angle found; "
                        f"falling back to rotation offsets ({actual_twenty_angle:.1f} deg)"
                    )
            elif FRONTON_DEBUG_LOGS:
                print(f"[Calibration] Using detected 20-point angle: {actual_twenty_angle:.1f} deg")

            desired_angle = 270.0
            camera_rotation = (actual_twenty_angle - desired_angle) % 360.0
            if camera_rotation > 180:
                camera_rotation -= 360.0
            if FRONTON_DEBUG_LOGS:
                print(
                    f"[Fronton] 20={actual_twenty_angle:.1f} desired={desired_angle:.1f} "
                    f"rot={camera_rotation:.1f} center=({center_pt[0]:.1f},{center_pt[1]:.1f})"
                )

            # Use a canvas that's 2x the larger dimension to ensure no cutoff
            max_dim = max(large_width, large_height)
            canvas_size = int(max_dim * 2)

            # Create a larger canvas with the transformed frame in the center
            canvas = np.zeros((canvas_size, canvas_size, 3), dtype=np.uint8)
            y_offset = (canvas_size - large_height) // 2
            x_offset = (canvas_size - large_width) // 2
            canvas[y_offset:y_offset+large_height, x_offset:x_offset+large_width] = transformed_frame

            # Rotate around the warped bull center so alignment is stable.
            rotation_center = (center_pt[0] + x_offset, center_pt[1] + y_offset)
            rotation_matrix = cv2.getRotationMatrix2D(rotation_center, camera_rotation, 1.0)
            rotated_canvas = cv2.warpAffine(
                canvas,
                rotation_matrix,
                (canvas_size, canvas_size),
                flags=cv2.INTER_LINEAR,
                borderMode=cv2.BORDER_CONSTANT,
                borderValue=(0, 0, 0)
            )

            # Crop back to the large size from the center
            rotated_frame = rotated_canvas[y_offset:y_offset+large_height, x_offset:x_offset+large_width]

            # Debug overlays removed (lines/text).
            
            # Start with the historic fixed radius, then expand/shrink from the actual
            # warped outer-double ellipse for this camera when available.
            fixed_roi_radius = int(self.double_outer_radius_px * scale_factor + 24)
            roi_radius = fixed_roi_radius
            rotated_outer_mask_pts = None
            board_margin_scale = 1.34

            if self.ellipse_calibration is not None and self.ellipse_calibration.outer_double_ellipse is not None:
                try:
                    ellipse = self.ellipse_calibration.outer_double_ellipse
                    (ecx, ecy), (ew, eh), eangle_deg = ellipse
                    sample_angles = np.linspace(0.0, 2.0 * math.pi, 72, endpoint=False)
                    ellipse_pts = []
                    cos_t = math.cos(math.radians(float(eangle_deg)))
                    sin_t = math.sin(math.radians(float(eangle_deg)))
                    axis_x = float(ew) / 2.0
                    axis_y = float(eh) / 2.0
                    for theta in sample_angles:
                        ex = axis_x * math.cos(theta)
                        ey = axis_y * math.sin(theta)
                        px = float(ecx) + ex * cos_t - ey * sin_t
                        py = float(ecy) + ex * sin_t + ey * cos_t
                        ellipse_pts.append((float(px), float(py)))

                    ellipse_arr = np.array([ellipse_pts], dtype=np.float32)
                    warped_ellipse = cv2.perspectiveTransform(ellipse_arr, adjusted_homography)[0]
                    radial_distances = np.linalg.norm(
                        warped_ellipse - np.array(center_pt, dtype=np.float32),
                        axis=1,
                    )
                    if radial_distances.size > 0:
                        dynamic_roi_radius = int(math.ceil(float(np.percentile(radial_distances, 98)) + 28.0))
                        roi_radius = max(280, min(dynamic_roi_radius, int(large_height / 2) - 4))

                    # Rotate the warped board edge with the same transform used for the frame
                    # so we can mask to the actual board silhouette instead of a generic circle.
                    warped_canvas = warped_ellipse + np.array([x_offset, y_offset], dtype=np.float32)
                    rotated_outer_mask_pts = cv2.transform(
                        warped_canvas.reshape(1, -1, 2),
                        rotation_matrix,
                    )[0]
                    rotated_outer_mask_pts[:, 0] -= x_offset
                    rotated_outer_mask_pts[:, 1] -= y_offset
                except Exception as e:
                    roi_radius = fixed_roi_radius
                    rotated_outer_mask_pts = None
                    if FRONTON_DEBUG_LOGS:
                        print(f"[FrontonCrop] polygon mask fallback: {e}")

            # Crop around the actual warped bull center for this camera.
            # Using the canonical model center can leave one camera visibly
            # off-center even when the front-on transform itself is correct.
            adjusted_center = (
                int(round(center_pt[0])),
                int(round(center_pt[1])),
            )

            if rotated_outer_mask_pts is not None and len(rotated_outer_mask_pts) >= 6:
                center_arr = np.array([float(adjusted_center[0]), float(adjusted_center[1])], dtype=np.float32)
                expanded = center_arr + (rotated_outer_mask_pts - center_arr) * board_margin_scale
                rotated_outer_mask_pts = expanded
            
            # Mask to the board edge when possible; fall back to the old circular mask.
            mask = np.zeros((large_height, large_width), dtype=np.uint8)
            if rotated_outer_mask_pts is not None and len(rotated_outer_mask_pts) >= 6:
                mask_polygon = np.round(rotated_outer_mask_pts).astype(np.int32)
                cv2.fillPoly(mask, [mask_polygon], 255)
            else:
                cv2.circle(mask, adjusted_center, roi_radius, 255, -1)
            
            # Apply the mask to create circular ROI
            roi_frame = cv2.bitwise_and(rotated_frame, rotated_frame, mask=mask)
            
            # Crop to the actual warped board bounds when we have a polygon mask.
            # This avoids one camera looking "smaller" just because it shares the
            # same fixed square crop as the others.
            if rotated_outer_mask_pts is not None and len(rotated_outer_mask_pts) >= 6:
                pad = 16
                min_x = float(np.min(rotated_outer_mask_pts[:, 0]))
                max_x = float(np.max(rotated_outer_mask_pts[:, 0]))
                min_y = float(np.min(rotated_outer_mask_pts[:, 1]))
                max_y = float(np.max(rotated_outer_mask_pts[:, 1]))

                half_w = max(adjusted_center[0] - min_x, max_x - adjusted_center[0])
                half_h = max(adjusted_center[1] - min_y, max_y - adjusted_center[1])
                half_size = int(math.ceil(max(half_w, half_h) + pad))

                roi_x1 = max(0, adjusted_center[0] - half_size)
                roi_y1 = max(0, adjusted_center[1] - half_size)
                roi_x2 = min(large_width, adjusted_center[0] + half_size)
                roi_y2 = min(large_height, adjusted_center[1] + half_size)
            else:
                roi_x1 = max(0, adjusted_center[0] - roi_radius)
                roi_y1 = max(0, adjusted_center[1] - roi_radius)
                roi_x2 = min(large_width, adjusted_center[0] + roi_radius)
                roi_y2 = min(large_height, adjusted_center[1] + roi_radius)

            if FRONTON_DEBUG_LOGS:
                print(
                    "[FrontonCrop] "
                    f"center=({adjusted_center[0]},{adjusted_center[1]}) "
                    f"radius={roi_radius} fixed_radius={fixed_roi_radius} "
                    f"mask={'poly' if rotated_outer_mask_pts is not None else 'circle'} "
                    f"bounds=({int(roi_x1)},{int(roi_y1)})-({int(roi_x2)},{int(roi_y2)}) "
                    f"large={large_width}x{large_height}"
                )
            
            # Crop to the bounding box
            cropped_roi = roi_frame[int(roi_y1):int(roi_y2), int(roi_x1):int(roi_x2)]

            # Normalize final output size so each camera's fronton preview presents the
            # board at a consistent visual scale even if its warped board bounds differ.
            target_size = int(fixed_roi_radius * 2)
            if target_size > 0 and cropped_roi.size > 0:
                cropped_roi = cv2.resize(
                    cropped_roi,
                    (target_size, target_size),
                    interpolation=cv2.INTER_LINEAR,
                )
            
            return cropped_roi
            
        except Exception as e:
            print(f"Error creating front-on view: {e}")
            import traceback
            traceback.print_exc()
            return frame
    
    def draw_dartboard_overlay(self, frame, draw_spider_only=True):
        """
        Draw dartboard overlay directly on camera frame without double transformation
        
        Args:
            frame: Input camera frame
            draw_spider_only: If True, only draw spider (rings and lines). If False, draw full model.
            
        Returns:
            numpy.ndarray: Frame with dartboard overlay
        """
        if self.ellipse_calibration is not None and self.ellipse_calibration.outer_double_ellipse is not None:
            try:
                return draw_ellipse_overlay(frame, self.ellipse_calibration, rotation_offset_deg=float(self.rotation_angle))
            except Exception:
                pass
        if not self.is_calibrated or self.inverse_homography_matrix is None:
            return frame
        
        try:
            # Create a copy of the frame to draw on
            overlay_frame = frame.copy()
            
            if draw_spider_only:
                # Draw spider elements directly on camera frame
                # This avoids double transformation and preserves the full camera view
                
                # Transform ring points from model to camera coordinates
                # Draw bullseye
                bull_center_cam = self.transform_point_to_camera(self.model_center)
                bull_center_cam = (int(bull_center_cam[0]), int(bull_center_cam[1]))
                
                # Calculate radius in camera space by transforming a point on the circle
                bull_edge_model = (self.model_center[0] + self.bull_radius_px, self.model_center[1])
                bull_edge_cam = self.transform_point_to_camera(bull_edge_model)
                bull_radius_cam = int(np.linalg.norm(np.array(bull_edge_cam) - np.array(bull_center_cam)))
                
                # Draw bullseye
                cv2.circle(overlay_frame, bull_center_cam, bull_radius_cam, (0, 0, 0), -1, lineType=cv2.LINE_AA)
                
                # Draw rings (outer bull, triple, double)
                for radius_px, color, thickness in [
                    (self.outer_bull_radius_px, (255, 0, 0), 2),      # Outer bull - blue
                    (self.triple_inner_radius_px, (0, 255, 0), 2),    # Triple inner - green
                    (self.triple_outer_radius_px, (0, 255, 0), 2),    # Triple outer - green
                    (self.double_inner_radius_px, (0, 0, 255), 2),    # Double inner - red
                    (self.double_outer_radius_px, (0, 0, 255), 2),    # Double outer - red
                ]:
                    # Transform circle by sampling points around it
                    circle_points = []
                    num_samples = 60  # More samples for smoother circles
                    for i in range(num_samples):
                        angle = 2 * np.pi * i / num_samples
                        x = self.model_center[0] + radius_px * np.cos(angle)
                        y = self.model_center[1] + radius_px * np.sin(angle)
                        cam_point = self.transform_point_to_camera((x, y))
                        circle_points.append([int(cam_point[0]), int(cam_point[1])])
                    
                    # Draw the circle as a polyline
                    circle_points = np.array(circle_points, dtype=np.int32)
                    cv2.polylines(overlay_frame, [circle_points], True, color, thickness, lineType=cv2.LINE_AA)
                
                # Draw sector lines (20 radial lines)
                for i in range(20):
                    angle = i * 2 * np.pi / 20 + SEGMENT_ANGLE_OFFSET
                    
                    # Start point (outer double ring)
                    start_x = self.model_center[0] + np.cos(angle) * self.double_outer_radius_px
                    start_y = self.model_center[1] + np.sin(angle) * self.double_outer_radius_px
                    start_cam = self.transform_point_to_camera((start_x, start_y))
                    
                    # End point (outer bull)
                    end_x = self.model_center[0] + np.cos(angle) * self.outer_bull_radius_px
                    end_y = self.model_center[1] + np.sin(angle) * self.outer_bull_radius_px
                    end_cam = self.transform_point_to_camera((end_x, end_y))
                    
                    # Draw line
                    cv2.line(overlay_frame,
                            (int(start_cam[0]), int(start_cam[1])),
                            (int(end_cam[0]), int(end_cam[1])),
                            (0, 0, 0), 1, lineType=cv2.LINE_AA)
                
                # Draw the 20 segment highlight wedge FIRST (so it's behind other elements)
                # Find the 20 segment (it's at index 0 in DARTBOARD_SEGMENTS)
                # Apply total rotation (fronton_offset + rotation_angle) to make the wedge rotate with the model
                segment_20_index = 0
                total_rotation = self.fronton_offset + self.rotation_angle
                rotation_radians = math.radians(total_rotation)
                segment_20_start_angle = segment_20_index * 2 * np.pi / 20 + SEGMENT_ANGLE_OFFSET - rotation_radians
                segment_20_end_angle = (segment_20_index + 1) * 2 * np.pi / 20 + SEGMENT_ANGLE_OFFSET - rotation_radians
                
                # Create polygon points for the 20 segment wedge in model space
                wedge_points_model = []
                num_arc_points = 30
                
                # Add points along the outer edge (double ring outer)
                for i in range(num_arc_points + 1):
                    angle = segment_20_start_angle + (segment_20_end_angle - segment_20_start_angle) * i / num_arc_points
                    x = self.model_center[0] + np.cos(angle) * self.double_outer_radius_px
                    y = self.model_center[1] + np.sin(angle) * self.double_outer_radius_px
                    wedge_points_model.append((x, y))
                
                # Add points along the inner edge (outer bull) in reverse
                for i in range(num_arc_points, -1, -1):
                    angle = segment_20_start_angle + (segment_20_end_angle - segment_20_start_angle) * i / num_arc_points
                    x = self.model_center[0] + np.cos(angle) * self.outer_bull_radius_px
                    y = self.model_center[1] + np.sin(angle) * self.outer_bull_radius_px
                    wedge_points_model.append((x, y))
                
                # Transform wedge points to camera space
                wedge_points_cam = []
                for point in wedge_points_model:
                    cam_point = self.transform_point_to_camera(point)
                    wedge_points_cam.append([int(cam_point[0]), int(cam_point[1])])
                
                # Draw the yellow highlight wedge
                wedge_points_cam = np.array(wedge_points_cam, dtype=np.int32)
                cv2.fillPoly(overlay_frame, [wedge_points_cam], (0, 255, 255), lineType=cv2.LINE_AA)  # Yellow
                
                # Draw an arrow pointing to the 20 segment (with rotation applied)
                arrow_angle = (segment_20_start_angle + segment_20_end_angle) / 2
                arrow_start_radius = self.double_outer_radius_px + 60
                arrow_end_radius = self.double_outer_radius_px + 20
                
                arrow_start_x = self.model_center[0] + np.cos(arrow_angle) * arrow_start_radius
                arrow_start_y = self.model_center[1] + np.sin(arrow_angle) * arrow_start_radius
                arrow_end_x = self.model_center[0] + np.cos(arrow_angle) * arrow_end_radius
                arrow_end_y = self.model_center[1] + np.sin(arrow_angle) * arrow_end_radius
                
                arrow_start_cam = self.transform_point_to_camera((arrow_start_x, arrow_start_y))
                arrow_end_cam = self.transform_point_to_camera((arrow_end_x, arrow_end_y))
                
                cv2.arrowedLine(overlay_frame,
                               (int(arrow_start_cam[0]), int(arrow_start_cam[1])),
                               (int(arrow_end_cam[0]), int(arrow_end_cam[1])),
                               (0, 0, 255), 3, tipLength=0.3, line_type=cv2.LINE_AA)  # Red arrow
                
                # Add "20 SEGMENT" text near the arrow
                text_x = self.model_center[0] + np.cos(arrow_angle) * (arrow_start_radius + 20)
                text_y = self.model_center[1] + np.sin(arrow_angle) * (arrow_start_radius + 20)
                text_cam = self.transform_point_to_camera((text_x, text_y))
                
                cv2.putText(overlay_frame, "20 SEGMENT",
                           (int(text_cam[0]) - 50, int(text_cam[1])),
                           cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2, cv2.LINE_AA)
                
                # Draw segment numbers (20 segment extra highlighted, with rotation applied)
                text_radius_px = int((self.triple_outer_radius_px + self.double_inner_radius_px) / 2)
                for i, score in enumerate(DARTBOARD_SEGMENTS):
                    angle = i * 2 * np.pi / 20 + SEGMENT_ANGLE_OFFSET - rotation_radians
                    text_x = self.model_center[0] + np.cos(angle) * text_radius_px
                    text_y = self.model_center[1] + np.sin(angle) * text_radius_px
                    text_cam = self.transform_point_to_camera((text_x, text_y))
                    
                    # Draw segment number
                    if score == 20:
                        # Make 20 segment number very prominent
                        font_scale = 1.2
                        color = (0, 0, 255)  # Red
                        thickness = 3
                    else:
                        font_scale = 0.5
                        color = (255, 255, 255)  # White
                        thickness = 1
                    
                    cv2.putText(overlay_frame, str(score),
                               (int(text_cam[0]) - 10, int(text_cam[1]) + 5),
                               cv2.FONT_HERSHEY_SIMPLEX, font_scale, color, thickness, cv2.LINE_AA)
            
            else:
                # Original method: transform full dartboard model
                # This can cause cutoff but shows the full model overlay
                transformed_frame = cv2.warpPerspective(
                    frame, self.homography_matrix,
                    (self.image_width, self.image_height)
                )
                
                alpha = 0.3
                overlay = cv2.addWeighted(
                    self.dartboard_model, alpha,
                    transformed_frame, 1 - alpha,
                    0
                )
                
                overlay_frame = cv2.warpPerspective(
                    overlay, self.inverse_homography_matrix,
                    (frame.shape[1], frame.shape[0])
                )
            
            return overlay_frame
            
        except Exception as e:
            print(f"Error creating dartboard overlay: {e}")
            import traceback
            traceback.print_exc()
            return frame
    
    def get_calibration_status(self):
        """Get current calibration status"""
        # Convert NumPy types to Python native types to avoid serialization issues
        center = tuple(map(float, self.dartboard_center)) if self.dartboard_center is not None else None
        calibration_quality = float(self.calibration_quality) if isinstance(self.calibration_quality, (np.float32, np.float64)) else self.calibration_quality
        rotation_angle = float(self.rotation_angle) if isinstance(self.rotation_angle, (np.float32, np.float64)) else self.rotation_angle
        
        return {
            'is_calibrated': self.is_calibrated,
            'center': center,
            'outer_points_count': len(self.reference_double_points) if self.is_calibrated else 0,
            'triple_points_count': len(self.reference_triple_points) if self.is_calibrated else 0,
            'calibration_quality': calibration_quality,
            'calibration_error_px': float(self.calibration_error_px) if hasattr(self, "calibration_error_px") and self.calibration_error_px is not None else None,
            'calibration_quality_metric': str(self.calibration_quality_metric),
            'homography_quality': float(self.homography_quality) if self.homography_quality is not None else None,
            'homography_error_px': float(self.homography_error_px) if self.homography_error_px is not None else None,
            'has_perspective_correction': True,
            'homography_matrix': self.homography_matrix is not None,
            'rotation_angle': rotation_angle,
            'current_segment': self.get_current_segment() if self.is_calibrated else 0
        }
    
    def get_camera_matrix(self):
        """
        Get camera matrix and distortion coefficients for stereo calibration
        
        Returns:
            tuple: (camera_matrix, distortion_coefficients)
        """
        # Estimate camera matrix based on image dimensions
        # For a pinhole camera model, the camera matrix is:
        # [[fx, 0, cx],
        #  [0, fy, cy],
        #  [0, 0,  1]]
        # where fx, fy are focal lengths and cx, cy is the principal point (usually image center)
        
        # Use image dimensions to estimate reasonable values
        cx = self.image_width / 2
        cy = self.image_height / 2
        
        # Estimate focal length (a common approximation is using image width)
        # For a standard camera with ~60° field of view, focal length ≈ image_width
        focal_length = self.image_width
        
        # Create camera matrix
        camera_matrix = np.array([
            [focal_length, 0, cx],
            [0, focal_length, cy],
            [0, 0, 1]
        ], dtype=np.float32)
        
        # Since we're using homography for perspective correction,
        # we can assume zero distortion
        dist_coeffs = np.zeros((5, 1), dtype=np.float32)
        
        return camera_matrix, dist_coeffs
