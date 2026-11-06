import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// No incremental cache binding: every page here reads the session cookie, so nothing is statically cached.
export default defineCloudflareConfig({});
