import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // unpdf ships a serverless build of pdf.js; keep it out of the bundle so
  // Vercel traces it as a normal node_modules dependency.
  serverExternalPackages: ["unpdf"],

  // Basic hardening headers. The mic permission is limited to this origin.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
