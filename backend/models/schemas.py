from __future__ import annotations

from pydantic import BaseModel


class RotationRequest(BaseModel):
    camera_index: int


class ScoreRequest(BaseModel):
    camera_index: int
    x: float
    y: float


