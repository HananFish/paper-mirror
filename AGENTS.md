# Agent installation and development guide

This is the canonical instruction file for coding agents. Read README.md and docs/INSTALL.md before changing installation or user-facing behavior.

## Install and verify

Work from the repository root. The project requires Python 3.11+ and Node.js 22.12+ with npm.

~~~sh
python scripts/setup.py --check-only
python scripts/setup.py
python scripts/run_tests.py
npm --prefix frontend run build
npm --prefix frontend run test:browser
python scripts/start.py
~~~

The installer creates .venv, installs backend requirements, runs npm ci against the committed frontend lockfile, builds the UI and generates data/sample_paper.pdf. Windows PowerShell wrappers are available. Windows browser tests use installed Edge; Linux/macOS tests need Chromium:

~~~sh
npm --prefix frontend exec -- playwright install chromium
~~~

Use .venv/Scripts/python.exe on Windows and .venv/bin/python on POSIX for direct backend commands. scripts/run_tests.py selects the project virtual environment automatically.

Basic setup does not install language models or download DocLayout-YOLO weights. Only run the optional heavier setup when needed for the user's requested work:

~~~sh
python scripts/setup.py --with-layout
~~~

See docs/INSTALL.md for manual layout-model installation and provider configuration. Mock is the initial provider and makes no real translation. Do not silently replace it with a paid provider. Keep .env values private.

## Repository map

- backend/app/parsing.py: PDF lines, columns, typography, image/table/caption regions and references.
- backend/app/document_semantics.py: compatibility and missing-caption recovery without rebuilding user blocks.
- backend/app/tasks.py, jobs.py: document-scoped jobs, state recovery and translation caching.
- backend/app/mirror_sync.py: optional background pull of tablet annotations from the published mirror site. Disabled when APP_DATA_DIR is set.
- backend/app/model_adapters.py, custom_adapters.py, vision.py: typed model contracts, trusted extension registration and default vision transport. See docs/MODEL_ADAPTERS.md. Keep optional models lazy and credentials in environment variables.
- backend/app/ocr.py, layout_yolo.py: local text extraction and optional layout inference.
- backend/app/routers/: validated document, region, annotation and export APIs.
- frontend/src/components/PdfPane.tsx, pdfTextSelection.ts: page rendering, cached layers and selection geometry.
- frontend/src/pages/Reader.tsx, Library.tsx: reader and library flows.
- frontend/src/mirrorStore.ts, clipboard.ts: static mirror mode (localStorage annotations) and safe clipboard fallback.
- frontend/src/readingHistory.ts: session-scoped record undo/redo; only successful writes enter history. Protect textarea undo and refuse conflicting external edits.
- scripts/publish_site.py, serve_site.py, sync_mirror.py: build/preview the static mirror site and merge tablet annotations back. See docs/MIRROR.md.
- functions/sync.js, functions/sync/[id].js: Cloudflare Pages Functions for optional annotation sync; cloud/mirror-sync is the deprecated Worker version.
- scripts/make_user_guide.py: source for the four-page manual and practice PDF.

Production uses one Uvicorn worker and local SQLite. Startup recovers interrupted jobs. Keep the optional layout model lazy and do not download assets during an API request.

## Data and correctness boundaries

- Preserve unrelated working changes. Never include private PDFs, app.db, .env, access tokens or model weights in commits.
- Tests must use temporary APP_DATA_DIR and offline providers. Never reparse a real library or run paid calls just to test.
- User authorization can permit a specific data update. Back up the affected data, scope that update, and report what changed.
- Keep existing block IDs, saved notes and annotations when adding missing captions. Reparse is a separate user action and intentionally rebuilds blocks.
- New geometry uses visual PDF points with coordinate_space=visual and rotation metadata. Legacy geometry uses unrotated coordinates; convert at the boundary.
- Each highlight selection has its own identity, color, quote and line rectangles. Avoid paragraph-level merging.
- Never cache Mock output as real translation memory. Forced glossary, target language and provider configuration must affect the relevant cache keys.
- OCR confidence and partial translation failures must remain visible; preserve uncertain source text.
- PDF export contains original pages, native annotations and a visible notes appendix. Do not describe it as a translated PDF export.
- Validate API inputs and cross-document anchors. Keep the existing local-origin and LAN pairing protections.
- Do not change the project or dependency licensing without the owner's instruction. docs/THIRD_PARTY.md records upstream terms.

## Validate changes

Run the tests relevant to your change, and the complete offline entry point before release:

~~~sh
python scripts/run_tests.py
npm --prefix frontend run build
npm --prefix frontend run test:history
npm --prefix frontend run test:browser
git diff --check
~~~

Browser tests generate their own papers and use an isolated backend and local translation stub. Set PLAYWRIGHT_CHANNEL=chrome only if using installed Chrome instead of Edge. PDF_QA_DIR can save review artifacts in a directory under data/.

After changing the manual, regenerate docs/UserGuide.pdf, render and inspect all pages, and verify parsing retains both captions and the appendix:

~~~sh
.venv/Scripts/python.exe scripts/make_user_guide.py docs/UserGuide.pdf
~~~

Do not commit render intermediates from data/ or tmp/. Keep README, the Chinese operation guide, the PDF manual and installer commands consistent. Do not claim tests or operating systems passed if they were not actually checked.
