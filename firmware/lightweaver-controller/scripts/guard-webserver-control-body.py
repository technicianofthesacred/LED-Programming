Import("env")

import hashlib
import os


EXPECTED_PARSING_SHA256 = "122de5397729899ac8600d545f7ed4b8a02298351a4f1b0fa5c7fa73f87a14d0"
WEBSERVER_PARSING_SUFFIX = os.path.join("libraries", "WebServer", "src", "Parsing.cpp")
BODY_BRANCH_ANCHOR = """    if (!isForm && _currentHandler && _currentHandler->canRaw(_currentUri)){"""
BODY_STATE_ANCHOR = """    bool isEncoded = false;"""
CONTENT_TYPE_ANCHOR = """      if (headerName.equalsIgnoreCase(FPSTR(Content_Type))){
        using namespace mime;"""
RAW_READ_ANCHOR = """        _currentRaw->currentSize = client.readBytes(_currentRaw->buf, HTTP_RAW_BUFLEN);"""
BOUNDED_RAW_READ = """        // Arduino Stream::readBytes waits for the requested byte count or its
        // five-second timeout. The upstream raw parser always asks for a full
        // buffer, so every final short JSON chunk stalls even though the whole
        // Content-Length has already arrived. Read exactly the remaining body
        // bytes while keeping the framework buffer as the hard upper bound.
        size_t lwRawRemaining = _clientContentLength - _currentRaw->totalSize;
        size_t lwRawReadLength = lwRawRemaining < static_cast<size_t>(HTTP_RAW_BUFLEN)
          ? lwRawRemaining
          : static_cast<size_t>(HTTP_RAW_BUFLEN);
        _currentRaw->currentSize = client.readBytes(_currentRaw->buf, lwRawReadLength);"""
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

#if defined(LW_WEB_WIFI_MAX_BODY_BYTES) && defined(LW_WEB_WIFI_ACK_MAX_BODY_BYTES)
    // WiFi credentials and handoff acknowledgements must reach the fixed raw
    // buffers without any framework-sized String/form allocation first.
    bool lwWifiEndpoint = _currentUri == "/api/wifi";
    bool lwWifiAckEndpoint = _currentUri == "/api/wifi/handoff-ack";
    size_t lwWifiBodyLimit = lwWifiAckEndpoint
      ? LW_WEB_WIFI_ACK_MAX_BODY_BYTES
      : LW_WEB_WIFI_MAX_BODY_BYTES;
    if ((lwWifiEndpoint || lwWifiAckEndpoint) &&
        (!isJson || isForm || isEncoded || _clientContentLength == 0 ||
         _clientContentLength > lwWifiBodyLimit)) {
      int status = (!isJson || isForm || isEncoded) ? 415
        : (_clientContentLength == 0 ? 411 : 413);
      const char* error = status == 415 ? "application/json required"
        : (status == 411 ? "content length required" : "wifi request too large");
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
      send(status, "application/json", String("{\"ok\":false,\"error\":\"") + error + "\"}");
      client.stop();
      return false;
    }
#endif

#if defined(LW_WEB_CONFIG_MAX_BODY_BYTES) && defined(LW_WEB_CANDIDATE_MAX_BODY_BYTES)
    // Config mutations accept only JSON and are rejected from parsed headers
    // before WebServer can enter multipart, form, plainBuf, or raw allocation.
    bool lwConfigEndpoint = _currentUri == "/api/config";
    bool lwCandidateEndpoint = _currentUri == "/api/wiring/candidate";
    size_t lwRuntimeBodyLimit = lwCandidateEndpoint
      ? LW_WEB_CANDIDATE_MAX_BODY_BYTES
      : LW_WEB_CONFIG_MAX_BODY_BYTES;
    if ((lwConfigEndpoint || lwCandidateEndpoint) &&
        (!isJson || isForm || isEncoded || _clientContentLength == 0 ||
         _clientContentLength > lwRuntimeBodyLimit)) {
      int status = (!isJson || isForm || isEncoded) ? 415
        : (_clientContentLength == 0 ? 411 : 413);
      const char* error = status == 415 ? "application/json required"
        : (status == 411 ? "content length required" : "runtime request too large");
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
      send(status, "application/json", String("{\"ok\":false,\"error\":\"") + error + "\"}");
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
    if (source_text.count(BODY_BRANCH_ANCHOR) != 1 or
            source_text.count(BODY_STATE_ANCHOR) != 1 or
            source_text.count(CONTENT_TYPE_ANCHOR) != 1 or
            source_text.count(RAW_READ_ANCHOR) != 1):
        print("Lightweaver WebServer guard anchor is missing or ambiguous; refusing to build.")
        build_env.Exit(1)

    source_text = source_text.replace(
        BODY_STATE_ANCHOR,
        BODY_STATE_ANCHOR + "\n    bool isJson = false;",
        1,
    )
    source_text = source_text.replace(
        CONTENT_TYPE_ANCHOR,
        CONTENT_TYPE_ANCHOR + r"""
        String lwMediaType = headerValue;
        int lwMediaSemicolon = lwMediaType.indexOf(';');
        if (lwMediaSemicolon >= 0) lwMediaType = lwMediaType.substring(0, lwMediaSemicolon);
        lwMediaType.trim();
        isJson = lwMediaType.equalsIgnoreCase("application/json");""",
        1,
    )
    patched_text = source_text.replace(
        BODY_BRANCH_ANCHOR,
        EARLY_CONTROL_GUARD + BODY_BRANCH_ANCHOR,
        1,
    )
    patched_text = patched_text.replace(
        RAW_READ_ANCHOR,
        BOUNDED_RAW_READ,
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
