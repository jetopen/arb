import type { NextConfig } from "next";
import { execSync } from "node:child_process";

// The deployed commit, exposed to the client + /api/health so repo-vs-deployed drift is visible (the Vercel
// project isn't git-connected, so nothing else records which commit is live). Prefers an explicit env, then
// Vercel's git metadata (the CLI populates VERCEL_GIT_COMMIT_SHA even for `vercel --prod` from a git dir),
// then a local `git rev-parse` for plain `next build`; "unknown" if none resolve.
function gitSha(): string {
  const fromEnv = process.env.NEXT_PUBLIC_GIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA;
  if (fromEnv) return fromEnv.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "unknown";
  }
}

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_GIT_SHA: gitSha(),
  },
};

export default nextConfig;
