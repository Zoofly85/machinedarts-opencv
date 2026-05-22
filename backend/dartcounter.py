#!/usr/bin/env python3
"""Compatibility launcher for the detector loop."""

import sys
from pathlib import Path

# Ensure `import backend...` works when this file is executed directly.
PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.core.detection.dartcounter import main


if __name__ == "__main__":
    main()
