# Work Order 5 Acceptance

Branch: `agent/task-1787807004-wo5`

Stack base: `agent/task-1787807004-wo4` (WO-4 draft PR #24)

## Scope

- Run the exported-runner aggregator on pull requests targeting `main-agent` or
  any `agent/**` stack branch.
- Use the exact Node version in `.nvmrc` on a Windows PowerShell runner.
- Preserve test output as `test-results.txt` even when the aggregator fails.
- Make the job result match the aggregator exit code.

## Acceptance evidence

- [x] Workflow triggers on draft and ready pull requests through the standard
  `pull_request` event.
- [x] Base-branch filters include `main-agent` and `agent/**`; `main` is not a
  configured target.
- [x] `actions/setup-node` reads `.nvmrc`.
- [x] Aggregator output is captured before its exit code is returned.
- [x] Artifact upload uses `if: always()` and fails if the result file is absent.
- [x] Exact local workflow step observed 233 PASS lines, 0 FAIL lines, and exit 0.
- [x] One temporary assertion break observed 232 PASS lines, 1 FAIL line, and
  exit 1; the FAIL line was present in `test-results.txt`.
- [x] The intentional break was restored and has no test-file diff.
- [x] Restored exact workflow step observed 233 PASS lines, 0 FAIL lines, and
  exit 0.
- [x] Draft PR #25 ran `Exported Node runners` successfully on GitHub Actions.
  A remote red run is intentionally not created because the required break may
  never appear in a commit or PR diff.

## Risk and rollback

Risk is limited to Windows runner availability and action availability. The
workflow has read-only repository permissions and no secrets. Rollback is a
revert of the focused WO-5 commit. Branch protection can require the
`Exported Node runners` check after the workflow is present on the base branch.
