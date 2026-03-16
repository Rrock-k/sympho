import pino from "pino";

export const logger = pino({
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino/file", options: { destination: 1 } }
      : undefined,
  level: process.env.LOG_LEVEL ?? "info",
});

export function issueLogger(issueId: string, issueIdentifier: string) {
  return logger.child({ issueId, issueIdentifier });
}
