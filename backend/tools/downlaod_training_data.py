#!/usr/bin/env python3
"""
Download all training data files from Firebase Storage to local PC.
"""

import os
import re
import sys
from pathlib import Path
import firebase_admin
from firebase_admin import credentials, storage

def _sanitize_filename(name: str, fallback: str) -> str:
    # Windows disallows <>:"/\|?* and trailing spaces/dots.
    cleaned = re.sub(r'[<>:"/\\\\|?*]', "_", name)
    cleaned = cleaned.strip().strip(".")
    if not cleaned:
        cleaned = fallback
    # Avoid Windows device names.
    reserved = {"con", "prn", "aux", "nul"} | {f"com{i}" for i in range(1, 10)} | {f"lpt{i}" for i in range(1, 10)}
    stem = Path(cleaned).stem.lower()
    if stem in reserved:
        cleaned = f"file_{cleaned}"
    return cleaned


def _ensure_writable_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    test_path = path / f".write_test_{os.getpid()}.tmp"
    try:
        test_path.write_text("ok", encoding="utf-8")
        test_path.unlink(missing_ok=True)
        return path
    except Exception:
        return None


def _default_download_dir() -> Path:
    home = Path.home()
    return home / "Downloads" / "training_data"


def download_all_files(download_dir: str = r"D:\training data"):
    """
    Download all files from Firebase Storage to local directory.
    
    Args:
        download_dir: Directory to save downloaded files (default: D:\training data)
    """
    # Create download directory - use absolute path relative to script location
    if not os.path.isabs(download_dir):
        # If relative path, make it relative to the script's directory
        script_dir = Path(__file__).parent
        download_path = script_dir / download_dir
    else:
        download_path = Path(download_dir)
    
    # Ensure destination is writable; fall back to user Downloads if not.
    writable = _ensure_writable_dir(download_path)
    if writable is None:
        fallback = _default_download_dir()
        writable = _ensure_writable_dir(fallback)
        if writable is None:
            raise RuntimeError(f"Unable to write to download directory: {download_path}")
        print(f"Download directory not writable: {download_path}")
        print(f"Falling back to: {writable}")
        download_path = writable
    else:
        download_path = writable
    
    print(f"📁 Download directory: {download_path.absolute()}")
    print()
    
    # Initialize Firebase
    try:
        cred_path = Path(__file__).parent / 'firebase_credentials.json'
        
        if not cred_path.exists():
            print(f"❌ Firebase credentials not found at: {cred_path}")
            print("Make sure firebase_credentials.json is in the same directory as this script")
            return
        
        # Initialize Firebase (only once)
        if not firebase_admin._apps:
            cred = credentials.Certificate(str(cred_path))
            firebase_admin.initialize_app(cred, {
                'storageBucket': 'dart-detector-training-data.firebasestorage.app'
            })
        
        bucket = storage.bucket()
        print("✅ Connected to Firebase Storage")
        print()
        
    except Exception as e:
        print(f"❌ Firebase initialization failed: {e}")
        return
    
    # List all files
    try:
        print("📋 Listing files in Firebase Storage...")
        blobs = list(bucket.list_blobs())
        
        if not blobs:
            print("⚠️  No files found in Firebase Storage")
            return
        
        print(f"Found {len(blobs)} file(s)")
        print()
        
        # Download each file
        for i, blob in enumerate(blobs, 1):
            file_name = blob.name
            # Extract just the filename without the path (e.g., "training_data/file.zip" -> "file.zip")
            filename_only = os.path.basename(file_name)
            safe_name = _sanitize_filename(filename_only, f"file_{i}.bin")
            local_path = download_path / safe_name
            
            print(f"[{i}/{len(blobs)}] Downloading: {file_name}")
            print(f"    Size: {blob.size / (1024*1024):.2f} MB")
            print(f"    Uploaded: {blob.time_created}")
            
            try:
                # Download the file
                blob.download_to_filename(str(local_path))
                
                # Verify file was created
                if local_path.exists():
                    actual_size = local_path.stat().st_size
                    print(f"    ✅ Saved to: {local_path}")
                    print(f"    ✅ Verified: {actual_size / (1024*1024):.2f} MB on disk")
                else:
                    print(f"    ❌ File not found after download: {local_path}")
                
            except Exception as e:
                print(f"    ❌ Download failed: {e}")
                import traceback
                traceback.print_exc()
            
            print()
        
        print("=" * 60)
        print(f"✅ Download complete!")
        print(f"📁 Files saved to: {download_path.absolute()}")
        print("=" * 60)
        
    except Exception as e:
        print(f"❌ Error listing/downloading files: {e}")
        import traceback
        traceback.print_exc()


def list_files_only():
    """Just list files without downloading."""
    try:
        cred_path = Path(__file__).parent / 'firebase_credentials.json'
        
        if not cred_path.exists():
            print(f"❌ Firebase credentials not found at: {cred_path}")
            return
        
        if not firebase_admin._apps:
            cred = credentials.Certificate(str(cred_path))
            firebase_admin.initialize_app(cred, {
                'storageBucket': 'dart-detector-training-data.firebasestorage.app'
            })
        
        bucket = storage.bucket()
        blobs = list(bucket.list_blobs())
        
        if not blobs:
            print("⚠️  No files found in Firebase Storage")
            return
        
        print(f"\n📋 Files in Firebase Storage ({len(blobs)} total):")
        print("=" * 80)
        
        total_size = 0
        for i, blob in enumerate(blobs, 1):
            size_mb = blob.size / (1024*1024)
            total_size += blob.size
            print(f"{i}. {blob.name}")
            print(f"   Size: {size_mb:.2f} MB")
            print(f"   Uploaded: {blob.time_created}")
            print()
        
        print("=" * 80)
        print(f"Total size: {total_size / (1024*1024):.2f} MB")
        
    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    print("=" * 60)
    print("Firebase Training Data Downloader")
    print("=" * 60)
    print()
    
    if len(sys.argv) > 1:
        if sys.argv[1] == "--list":
            list_files_only()
        elif sys.argv[1] == "--help":
            print("Usage:")
            print('  python download_training_data.py                    # Download to D:\\training data')
            print("  python download_training_data.py <directory>        # Download to custom directory")
            print("  python download_training_data.py --list             # List files only")
            print("  python download_training_data.py --help             # Show this help")
            print()
            print("Examples:")
            print('  python download_training_data.py "D:\\training data"')
            print('  python download_training_data.py C:\\Users\\YourName\\Downloads\\training')
        elif sys.argv[1].startswith("--"):
            print(f"Unknown option: {sys.argv[1]}")
            print("Use --help for usage information")
        else:
            # Custom directory specified
            download_all_files(sys.argv[1])
    else:
        download_all_files()
