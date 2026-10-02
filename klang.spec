# PyInstaller build recipe for Klang.exe
# Build:  pyinstaller klang.spec
# The version comes from the KLANG_VERSION environment variable (e.g. "1.2.0").
import os
from PyInstaller.utils.hooks import collect_data_files

version = os.environ.get("KLANG_VERSION", "0.0.0").lstrip("v")
nums = tuple((list(map(int, version.split(".")[:3])) + [0, 0, 0])[:3]) + (0,)

datas = [("ui", "ui")] + collect_data_files("ytmusicapi")

version_info = None
if os.name == "nt":
    from PyInstaller.utils.win32.versioninfo import (
        FixedFileInfo, StringFileInfo, StringStruct, StringTable, VarFileInfo, VarStruct, VSVersionInfo,
    )

    version_info = VSVersionInfo(
        ffi=FixedFileInfo(filevers=nums, prodvers=nums),
        kids=[
            StringFileInfo([StringTable("040904B0", [
                StringStruct("CompanyName", "Klang"),
                StringStruct("FileDescription", "Klang music player"),
                StringStruct("FileVersion", version),
                StringStruct("InternalName", "Klang"),
                StringStruct("OriginalFilename", "Klang.exe"),
                StringStruct("ProductName", "Klang"),
                StringStruct("ProductVersion", version),
                StringStruct("LegalCopyright", "MIT License"),
            ])]),
            VarFileInfo([VarStruct("Translation", [1033, 1200])]),
        ],
    )

a = Analysis(
    ["server.py"],
    datas=datas,
    excludes=["tkinter"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    name="Klang",
    icon="ui/klang.ico",
    version=version_info,
    console=False,
    upx=False,
    strip=False,
)
