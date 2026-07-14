Import("env")

import hashlib
import os


EXPECTED_PARSING_SHA256 = "122de5397729899ac8600d545f7ed4b8a02298351a4f1b0fa5c7fa73f87a14d0"
WEBSERVER_PARSING_SUFFIX = os.path.join("libraries", "WebServer", "src", "Parsing.cpp")
BODY_BRANCH_ANCHOR = """    if (!isForm && _currentHandler && _currentHandler->canRaw(_currentUri)){"""
EARLY_CONTROL_GUARD = r"""
#if defined(LW_WEB_CONTROL_MAX_BODY_BYTES)
    // Lightweaver's control endpoint must reject from parsed headers, before
    // WebServer selects raw, plainBuf, urlencoded, or multipart body handling.
    if (_currentUri == "/api/control" &&
        _clientContentLength > LW_WEB_CONTROL_MAX_BODY_BYTES) {
      extern bool corsOriginAllowed(const String& origin);
      String origin = header("Origin");
      if (corsOriginAllowed(origin)) {
        sendHeader("Access-Control-Allow-Origin", origin);
        sendHeader("Vary", "Origin");
        sendHeader("Access-Control-Allow-Headers", "Content-Type");
        sendHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        sendHeader("Access-Control-Allow-Private-Network", "true");
      }
      sendHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      send(413, "application/json", "{\"ok\":false,\"error\":\"control request too large\"}");
      client.stop();
      return false;
    }
#endif

"""


def guard_control_body_before_framework_buffer(build_env, node):
    source_path = node.srcnode().get_abspath()
    if not os.path.normpath(source_path).endswith(WEBSERVER_PARSING_SUFFIX):
        return node

    with open(source_path, "rb") as source_file:
        source_bytes = source_file.read()
    actual_hash = hashlib.sha256(source_bytes).hexdigest()
    if actual_hash != EXPECTED_PARSING_SHA256:
        print(
            "Lightweaver refuses to patch an unverified Arduino WebServer Parsing.cpp\n"
            f"expected {EXPECTED_PARSING_SHA256}\nactual   {actual_hash}\n"
            "Review the new parser before updating the pinned hash."
        )
        build_env.Exit(1)

    source_text = source_bytes.decode("utf-8")
    if source_text.count(BODY_BRANCH_ANCHOR) != 1:
        print("Lightweaver WebServer guard anchor is missing or ambiguous; refusing to build.")
        build_env.Exit(1)

    patched_text = source_text.replace(
        BODY_BRANCH_ANCHOR,
        EARLY_CONTROL_GUARD + BODY_BRANCH_ANCHOR,
        1,
    )
    generated_dir = build_env.subst("$BUILD_DIR/lightweaver-framework-guard")
    generated_path = os.path.join(generated_dir, "Parsing.cpp")
    os.makedirs(generated_dir, exist_ok=True)
    current_text = None
    if os.path.exists(generated_path):
        with open(generated_path, "r", encoding="utf-8") as generated_file:
            current_text = generated_file.read()
    if current_text != patched_text:
        with open(generated_path, "w", encoding="utf-8", newline="\n") as generated_file:
            generated_file.write(patched_text)
    return build_env.File(generated_path)


env.AddBuildMiddleware(guard_control_body_before_framework_buffer)
