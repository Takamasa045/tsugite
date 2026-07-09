console.log(
  JSON.stringify({
    ok: false,
    code: "backend.fixture_failed",
    issue: {
      code: "backend.fixture_failed",
      message: "structured fixture failure"
    }
  })
);
process.exit(30);
