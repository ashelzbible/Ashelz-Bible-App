// Must be imported first: configures an isolated test environment before the app modules read process.env.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://wazzupp:wazzupp@127.0.0.1:5432/wazzupp_test';
process.env.URL_SIGNING_SECRET = 'test-secret-test-secret-test-secret-123456';
process.env.RATE_LIMIT_DISABLED = 'true';
process.env.MEDIA_DIR = `/tmp/wazzupp-test-media-${process.pid}`;
process.env.REQUIRE_VERIFICATION = 'true';
process.env.REDIS_URL = '';
