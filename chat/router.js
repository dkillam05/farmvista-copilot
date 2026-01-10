// /chat/router.js  (FULL FILE)
// Rev: 2026-01-10-router-clean1
//
// Clean router: single handler.

'use strict';

import { handleChatHttp } from "./handleChat.js";

export function mountChatRoutes(app) {
  app.post("/chat", handleChatHttp);
}
