#pragma once

class WebServer;

void registerLightweaverCardStudio(WebServer& server);
bool lightweaverCardStudioMutationsEnabled();
const char* lightweaverCardStudioValidationError();
