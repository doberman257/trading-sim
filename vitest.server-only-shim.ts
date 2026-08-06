// Vitest runs plain Node, not Next's webpack build, so it never applies
// Next's conditional swap that makes the real "server-only" package a
// no-op on the server and a throwing guard on the client. Aliased in place
// of the real package for tests only (see vitest.config.ts and
// vitest.integration.config.ts) - equivalent to what next/jest's own test
// preset does for the same reason. Production and dev builds still go
// through Next's real webpack pipeline and get the real guard.
export {};
