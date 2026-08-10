#pragma once

#include <Arduino.h>
#include <FS.h>

class WebServer;

static constexpr size_t LW_PROJECT_REPOSITORY_QUOTA_BYTES = 3u * 1024u * 1024u;
static constexpr size_t LW_PROJECT_RECOVERY_HEADROOM_BYTES = 64u * 1024u;
static constexpr size_t LW_PROJECT_MAX_BYTES = 768u * 1024u;
static constexpr size_t LW_PROJECT_MAX_CHUNK_BYTES = 2048;
static constexpr size_t LW_PROJECT_HTTP_MAX_BODY_BYTES = 4096;

struct LightweaverProjectHead {
  String projectId;
  String current;
  String currentBlob;
  String knownGood;
  String knownGoodBlob;
  uint32_t generation = 0;
};

class LightweaverProjectRepository {
 public:
  bool begin(String& message, bool readOnlyProbation = false);
  bool available() const { return available_; }
  String currentHead() const { return head_.current; }
  String currentProjectId() const { return head_.projectId; }
  bool stagingActive() const { return stagedProjectId_.length() > 0; }
  const LightweaverProjectHead& head() const { return head_; }
  size_t quotaBytes() const { return LW_PROJECT_REPOSITORY_QUOTA_BYTES; }
  size_t usedBytes() const;
  bool preflight(const String& projectId, size_t totalBytes,
                 const String& expectedHead, String& message) const;
  bool beginStaging(const String& projectId, size_t totalBytes,
                    size_t chunkSize, const String& contentHash,
                    const String& transferHash,
                    const String& expectedHead, String& message);
  bool appendChunk(uint32_t chunkIndex, const uint8_t* bytes, size_t size,
                   String& message);
  bool commit(const String& expectedHead, String& promotedHead,
              String& message);
  bool remove(const String& projectId, const String& expectedHead,
              String& message);
  File openCurrent(String& message) const;
  void cleanupAbandonedStaging();

 private:
  bool loadHead(String& message);
  bool writeHeadAtomically(const LightweaverProjectHead& head, String& message);
  bool hashFile(const String& path, String& hash, size_t& bytes,
                String& message) const;
  String immutablePath(const String& hash) const;
  bool validProjectId(const String& value) const;
  bool validHash(const String& value) const;

  bool available_ = false;
  LightweaverProjectHead head_;
  String stagedProjectId_;
  String stagedProjectHead_;
  String stagedTransferHash_;
  String stagedExpectedHead_;
  size_t stagedTotalBytes_ = 0;
  size_t stagedChunkSize_ = 0;
  size_t stagedBytes_ = 0;
  uint32_t nextChunkIndex_ = 0;
};

LightweaverProjectRepository& lightweaverProjectRepository();
void registerLightweaverProjectRepository(WebServer& server);
