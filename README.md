# Zip Zerver

A browser-based viewer for websites packaged in ZIP files.

**Live Demo:** https://dsmmcken.github.io/zip-zerver/

## Why

This tool was originally built to view Playwright HTML report archives downloaded from CI pipelines, but works with any static site packaged as a ZIP file. Playwright reports fail to load traces unless served from a web server.

Some sites fail when opened directly via the `file://` protocol because browsers enforce strict security boundaries on local files:

- **Strict Origin Policy (CORS):** Browsers treat local files as unique or "null" origins, blocking the Fetch API from accessing other local data files or assets to prevent cross-origin security risks.

- **Module Loading Restrictions (ESM):** Modern JavaScript ES Modules (`import`/`export`) are generally disabled over `file://` because they require specific MIME types that only a web server can provide.

- **Service Worker Restrictions:** Browsers require a Secure Origin (`https://` or `localhost`) to register Service Workers; they are explicitly disabled for `file://` paths, breaking apps that rely on them for request interception or offline functionality.

## Features

- **Drag & Drop** - Drop a ZIP file directly onto the page
- **Privacy Focused** - All processing happens locally in your browser

## Architecture

The viewer works entirely in the browser with no server-side processing:

1. **ZIP Extraction** - Uses [zip.js](https://gildas-lormeau.github.io/zip.js/) to extract files in-memory
2. **Blob URLs** - Each extracted file is converted to a blob URL, creating a virtual file system
3. **URL Interception** - JavaScript patches `URL`, `fetch`, and `XMLHttpRequest` to intercept relative path requests and map them to the correct blob URLs
4. **Dynamic Resource Handling** - A `MutationObserver` and property setters on `HTMLImageElement`, `HTMLVideoElement`, etc. ensure dynamically added elements also resolve correctly
5. **Iframe Isolation** - The web app runs in an iframe with all patches injected, keeping the viewer and app environments separate

This approach allows web applications to function as if served from a real web server.

## Self-Hosting

The viewer is a simple static site with no build step.

## License

MIT
