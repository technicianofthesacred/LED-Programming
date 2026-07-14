import os
import re

Import("env")

build_id = os.environ.get("LW_BUILD_ID", "dev")
if build_id != "dev" and not re.fullmatch(r"[0-9a-f]{40}", build_id):
    raise ValueError("LW_BUILD_ID must be the exact 40-character source revision")

env.Append(CPPDEFINES=[("LW_BUILD_ID", f'\\"{build_id}\\"')])
