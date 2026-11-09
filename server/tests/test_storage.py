from types import SimpleNamespace

import pytest

from app import storage


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "get_settings", lambda: SimpleNamespace(data_dir=str(tmp_path)))
    return tmp_path


def test_put_get_and_delete_objects(data_dir):
    storage.put_object("2026/10/report.pdf", b"%PDF", "application/pdf")
    assert (data_dir / "files/2026/10/report.pdf").read_bytes() == b"%PDF"
    assert storage.get_object("2026/10/report.pdf") == b"%PDF"

    storage.delete_object("2026/10/report.pdf")
    with pytest.raises(FileNotFoundError):
        storage.get_object("2026/10/report.pdf")
    # Deleting a missing object is idempotent.
    storage.delete_object("2026/10/report.pdf")


def test_overwrite_is_atomic_and_leaves_no_temporary_files(data_dir):
    storage.put_object("note.txt", b"old", "text/plain")
    storage.put_object("note.txt", b"new", "text/plain")
    assert storage.get_object("note.txt") == b"new"
    assert [path.name for path in (data_dir / "files").iterdir()] == ["note.txt"]


@pytest.mark.parametrize("key", [
    "", "../outside", "a/../../outside", "/etc/passwd", "a\\b", "nul\x00byte",
])
def test_invalid_keys_never_escape_the_storage_root(key):
    with pytest.raises(ValueError):
        storage.get_object(key)
    with pytest.raises(ValueError):
        storage.put_object(key, b"x", "text/plain")


def test_absolute_paths_are_rejected_even_if_inside_the_root(data_dir):
    with pytest.raises(ValueError):
        storage.put_object(str(data_dir / "files/note.txt"), b"x", "text/plain")


def test_symlinked_directory_cannot_escape_the_root(data_dir, tmp_path_factory):
    outside = tmp_path_factory.mktemp("outside")
    (data_dir / "files").mkdir()
    try:
        (data_dir / "files/link").symlink_to(outside, target_is_directory=True)
    except OSError as error:
        if getattr(error, "winerror", None) == 1314:
            pytest.skip("Windows account cannot create symbolic links")
        raise
    # resolve() follows the symlink, so the containment check rejects it.
    with pytest.raises(ValueError):
        storage.put_object("link/note.txt", b"x", "text/plain")
    assert not (outside / "note.txt").exists()


def test_check_storage_creates_the_root_and_removes_its_probe(data_dir):
    storage.check_storage()
    assert (data_dir / "files").is_dir()
    assert list((data_dir / "files").iterdir()) == []


def test_delete_refuses_an_invalid_key_without_raising(data_dir):
    (data_dir / "files").mkdir()
    (data_dir / "files/keep.txt").write_bytes(b"keep")
    storage.delete_object("../files/keep.txt")
    assert (data_dir / "files/keep.txt").read_bytes() == b"keep"
