import os
import re

Import("env")

build_id = os.environ.get("LW_BUILD_ID", "dev")
if build_id != "dev" and not re.fullmatch(r"[0-9a-f]{40}", build_id):
    raise ValueError("LW_BUILD_ID must be the exact 40-character source revision")

# The human-facing firmware identity: the commit count of the same source
# revision — the number GitHub prints as "N Commits" — so a card can answer
# "which build am I on?" with a number the owner can compare against GitHub and
# against the published release, instead of a 40-character hash.
# 0 means "unofficial bench build" — only CI injects a real number.
build_number = os.environ.get("LW_BUILD_NUMBER", "0")
if not re.fullmatch(r"(0|[1-9][0-9]*)", build_number):
    raise ValueError("LW_BUILD_NUMBER must be a non-negative integer")
if build_id == "dev" and build_number != "0":
    raise ValueError("LW_BUILD_NUMBER must be 0 when LW_BUILD_ID is a dev build")
if build_id != "dev" and build_number == "0":
    raise ValueError("LW_BUILD_NUMBER must be injected alongside a release LW_BUILD_ID")

env.Append(CPPDEFINES=[
    ("LW_BUILD_ID", f'\\"{build_id}\\"'),
    ("LW_BUILD_NUMBER", build_number),
])
