const MIME_TYPES = {
  'html': 'text/html',
  'htm': 'text/html',
  'css': 'text/css',
  'js': 'application/javascript',
  'mjs': 'application/javascript',
  'json': 'application/json',
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'gif': 'image/gif',
  'svg': 'image/svg+xml',
  'webp': 'image/webp',
  'ico': 'image/x-icon',
  'webm': 'video/webm',
  'mp4': 'video/mp4',
  'woff': 'font/woff',
  'woff2': 'font/woff2',
  'ttf': 'font/ttf',
  'eot': 'application/vnd.ms-fontobject',
  'zip': 'application/zip',
  'txt': 'text/plain',
  'xml': 'application/xml',
  'map': 'application/json'
};

function getMimeType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

// Store blob URLs for cleanup
let createdBlobUrls = [];

// DOM elements
const dropZone = document.getElementById('drop-zone');
const loading = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');
const errorDiv = document.getElementById('error');
const errorMessage = document.getElementById('error-message');
const reportFrame = document.getElementById('report-frame');
const backButton = document.getElementById('back-button');
const mainContainer = document.getElementById('main-container');
const fileInput = document.getElementById('file-input');
const urlInput = document.getElementById('url-input');
const urlLoadBtn = document.getElementById('url-load-btn');
const inputWrapper = document.getElementById('input-wrapper');
const urlSection = document.getElementById('url-section');
const uploadBtn = document.getElementById('upload-btn');

// Upload button handler
uploadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) {
    handleFile(e.target.files[0]);
  }
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');

  const file = e.dataTransfer.files[0];
  if (file) {
    handleFile(file);
  }
});

// Prevent default drag behavior on window
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// URL load handlers
urlLoadBtn.addEventListener('click', (e) => { loadFromUrl(); e.stopPropagation(); });
urlInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') loadFromUrl();
});
urlInput.addEventListener('click', (e) => {
  e.stopPropagation(); // Prevent triggering file select
});

async function loadFromUrl() {
  let url = urlInput.value.trim();
  if (!url) {
    showError('Please enter a URL');
    return;
  }

  try {
    showLoading('Fetching ZIP from URL...');

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const blob = await response.blob();
    const file = new File([blob], 'report.zip', { type: 'application/zip' });
    await handleFile(file);

  } catch (err) {
    console.error('Error loading from URL:', err);
    let errorMsg = `Failed to load ZIP from URL: ${err.message}`;

    // Add helpful hint for CORS errors
    if (err.message.includes('Failed to fetch') || err.name === 'TypeError') {
      errorMsg += '<br><br><small>This may be a CORS error. The server hosting the ZIP file must allow cross-origin requests, or you can download the file and drop it here instead.</small>';
    }

    showError(errorMsg);
  }
}

// Back button - cleanup blob URLs
backButton.addEventListener('click', () => {
  // Revoke all blob URLs to free memory
  createdBlobUrls.forEach(url => URL.revokeObjectURL(url));
  createdBlobUrls = [];

  reportFrame.src = 'about:blank';
  reportFrame.classList.remove('active');
  backButton.classList.remove('active');
  mainContainer.style.display = '';
  hideLoading();
  hideError();
});

function showError(message) {
  loading.classList.remove('active');
  errorDiv.classList.add('active');
  errorMessage.innerHTML = message;
}

function hideError() {
  errorDiv.classList.remove('active');
}

function showLoading(text) {
  hideError();
  loading.classList.add('active');
  loadingText.textContent = text;
}

function hideLoading() {
  loading.classList.remove('active');
}

// Normalize path (remove ./ and resolve ../)
function normalizePath(basePath, relativePath) {
  if (relativePath.startsWith('/')) {
    return relativePath.substring(1);
  }
  if (relativePath.startsWith('http://') || relativePath.startsWith('https://') || relativePath.startsWith('data:') || relativePath.startsWith('blob:')) {
    return null; // External URL, don't process
  }

  // Get directory of base path
  const baseDir = basePath.includes('/') ? basePath.substring(0, basePath.lastIndexOf('/') + 1) : '';

  // Combine and normalize
  let combined = baseDir + relativePath;

  // Remove ./
  combined = combined.replace(/\.\//g, '');

  // Resolve ../
  const parts = combined.split('/');
  const resolved = [];
  for (const part of parts) {
    if (part === '..') {
      resolved.pop();
    } else if (part !== '' && part !== '.') {
      resolved.push(part);
    }
  }

  return resolved.join('/');
}

async function handleFile(file) {
  if (!file.name.endsWith('.zip')) {
    showError('Please drop a ZIP file containing a Playwright report.');
    return;
  }

  try {
    showLoading('Loading zip.js library...');

    // Dynamically load zip.js
    const { BlobReader, BlobWriter, ZipReader } = await import(
      'https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.7.34/+esm'
    );

    showLoading('Reading ZIP file...');

    // Extract the zip
    const zipReader = new ZipReader(new BlobReader(file));
    const entries = await zipReader.getEntries();

    const files = new Map(); // path -> blob
    const blobUrls = new Map(); // path -> blob URL
    let indexPath = null;
    let commonPrefix = null;

    // First pass: find common prefix
    for (const entry of entries) {
      if (!entry.directory) {
        const path = entry.filename;

        // Detect common prefix (e.g., "playwright-report/")
        if (commonPrefix === null) {
          const slashIndex = path.indexOf('/');
          if (slashIndex > 0) {
            commonPrefix = path.substring(0, slashIndex + 1);
          } else {
            commonPrefix = '';
          }
        }

        // Check if this entry starts with different prefix
        if (commonPrefix && !path.startsWith(commonPrefix)) {
          commonPrefix = '';
        }
      }
    }

    showLoading(`Extracting ${entries.length} files...`);

    // Second pass: extract files
    let extracted = 0;
    for (const entry of entries) {
      if (!entry.directory) {
        const blob = await entry.getData(new BlobWriter());

        // Remove common prefix for cleaner paths
        let path = entry.filename;
        if (commonPrefix && path.startsWith(commonPrefix)) {
          path = path.substring(commonPrefix.length);
        }

        files.set(path, blob);

        // Create blob URL
        const mimeType = getMimeType(path);
        const typedBlob = new Blob([blob], { type: mimeType });
        const blobUrl = URL.createObjectURL(typedBlob);
        blobUrls.set(path, blobUrl);
        createdBlobUrls.push(blobUrl);

        if (path === 'index.html' || path.endsWith('/index.html')) {
          if (!indexPath || path === 'index.html') {
            indexPath = path;
          }
        }

        extracted++;
        if (extracted % 50 === 0) {
          showLoading(`Extracting files... (${extracted}/${entries.length})`);
        }
      }
    }

    await zipReader.close();

    if (!indexPath) {
      showError('No index.html found in the ZIP file. Is this a valid Playwright report?');
      return;
    }

    showLoading('Processing report...');

    // Create the URL/fetch patching script to inject
    function createPatchScript(urlMap) {
      const mapJson = JSON.stringify(Object.fromEntries(urlMap));
      return `
<script>
(function() {
  const blobUrlMap = ${mapJson};

  // Helper to resolve relative paths
  function resolvePath(relativePath, basePath) {
    if (!relativePath || relativePath.startsWith('blob:') || relativePath.startsWith('data:') ||
        relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
      return null;
    }

    // Handle absolute paths
    if (relativePath.startsWith('/')) {
      return relativePath.substring(1);
    }

    // Get directory of base path
    const baseDir = basePath && basePath.includes('/') ? basePath.substring(0, basePath.lastIndexOf('/') + 1) : '';

    // Combine and normalize
    let combined = baseDir + relativePath;
    combined = combined.replace(/\\.\\//, '');

    const parts = combined.split('/');
    const resolved = [];
    for (const part of parts) {
      if (part === '..') {
        resolved.pop();
      } else if (part !== '' && part !== '.') {
        resolved.push(part);
      }
    }

    return resolved.join('/');
  }

  // Track current "virtual" path for relative resolution
  window.__virtualPath = 'index.html';

  // Patch fetch
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    let url = input;
    if (input instanceof Request) {
      url = input.url;
    }

    if (typeof url === 'string') {
      const resolved = resolvePath(url, window.__virtualPath);
      if (resolved && blobUrlMap[resolved]) {
        return originalFetch(blobUrlMap[resolved], init);
      }
    }

    return originalFetch(input, init);
  };

  // Patch URL constructor
  const OriginalURL = window.URL;
  window.URL = function(url, base) {
    // If base is a blob URL, try to resolve the relative path
    if (base && typeof base === 'string' && base.startsWith('blob:')) {
      const resolved = resolvePath(url, window.__virtualPath);
      if (resolved && blobUrlMap[resolved]) {
        return new OriginalURL(blobUrlMap[resolved]);
      }
      // For unresolved paths, create a fake URL that won't break
      try {
        return new OriginalURL(url, 'http://localhost/');
      } catch(e) {
        return new OriginalURL('http://localhost/' + url);
      }
    }
    return new OriginalURL(url, base);
  };
  // Copy static methods
  Object.setPrototypeOf(window.URL, OriginalURL);
  window.URL.createObjectURL = OriginalURL.createObjectURL.bind(OriginalURL);
  window.URL.revokeObjectURL = OriginalURL.revokeObjectURL.bind(OriginalURL);

  // Patch XMLHttpRequest
  const OriginalXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function() {
    const xhr = new OriginalXHR();
    const originalOpen = xhr.open;
    xhr.open = function(method, url, ...rest) {
      let resolvedUrl = url;
      if (typeof url === 'string') {
        const resolved = resolvePath(url, window.__virtualPath);
        if (resolved && blobUrlMap[resolved]) {
          resolvedUrl = blobUrlMap[resolved];
        }
      }
      return originalOpen.call(this, method, resolvedUrl, ...rest);
    };
    return xhr;
  };
  window.XMLHttpRequest.prototype = OriginalXHR.prototype;

  // Patch element src/href setters for dynamic content
  function patchElementProperty(proto, prop) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
    if (descriptor && descriptor.set) {
      const originalSet = descriptor.set;
      Object.defineProperty(proto, prop, {
        ...descriptor,
        set: function(value) {
          if (typeof value === 'string') {
            const resolved = resolvePath(value, window.__virtualPath);
            if (resolved && blobUrlMap[resolved]) {
              return originalSet.call(this, blobUrlMap[resolved]);
            }
          }
          return originalSet.call(this, value);
        }
      });
    }
  }

  // Patch src on various element types
  patchElementProperty(HTMLImageElement.prototype, 'src');
  patchElementProperty(HTMLVideoElement.prototype, 'src');
  patchElementProperty(HTMLAudioElement.prototype, 'src');
  patchElementProperty(HTMLSourceElement.prototype, 'src');
  patchElementProperty(HTMLTrackElement.prototype, 'src');
  patchElementProperty(HTMLScriptElement.prototype, 'src');
  patchElementProperty(HTMLIFrameElement.prototype, 'src');

  // Also watch for attribute changes via MutationObserver
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        const el = mutation.target;
        const attr = mutation.attributeName;
        if (attr === 'src' || attr === 'href') {
          const value = el.getAttribute(attr);
          if (value && !value.startsWith('blob:') && !value.startsWith('data:') && !value.startsWith('http')) {
            const resolved = resolvePath(value, window.__virtualPath);
            if (resolved && blobUrlMap[resolved]) {
              el.setAttribute(attr, blobUrlMap[resolved]);
            }
          }
        }
      }
      // Handle newly added elements
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === 1) {
            const processEl = (el) => {
              ['src', 'href'].forEach(attr => {
                const value = el.getAttribute && el.getAttribute(attr);
                if (value && !value.startsWith('blob:') && !value.startsWith('data:') && !value.startsWith('http')) {
                  const resolved = resolvePath(value, window.__virtualPath);
                  if (resolved && blobUrlMap[resolved]) {
                    el.setAttribute(attr, blobUrlMap[resolved]);
                  }
                }
              });
              // Process children
              if (el.querySelectorAll) {
                el.querySelectorAll('[src], [href]').forEach(processEl);
              }
            };
            processEl(node);
          }
        });
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'href']
  });
})();
</` + `script>`;
    }

    // Process HTML and CSS files to rewrite URLs
    async function processHtml(htmlPath, blobUrls) {
      const blob = files.get(htmlPath);
      const text = await blob.text();

      // Rewrite URLs in HTML
      let processed = text;

      // Replace src attributes
      processed = processed.replace(/(src|href)=(["'])([^"']+)\2/gi, (match, attr, quote, url) => {
        const resolved = normalizePath(htmlPath, url);
        if (resolved && blobUrls.has(resolved)) {
          return `${attr}=${quote}${blobUrls.get(resolved)}${quote}`;
        }
        return match;
      });

      // Replace url() in inline styles
      processed = processed.replace(/url\(["']?([^"')]+)["']?\)/gi, (match, url) => {
        const resolved = normalizePath(htmlPath, url);
        if (resolved && blobUrls.has(resolved)) {
          return `url("${blobUrls.get(resolved)}")`;
        }
        return match;
      });

      // Handle import statements and dynamic imports in script tags
      processed = processed.replace(/from\s+["']([^"']+)["']/g, (match, url) => {
        const resolved = normalizePath(htmlPath, url);
        if (resolved && blobUrls.has(resolved)) {
          return `from "${blobUrls.get(resolved)}"`;
        }
        return match;
      });

      processed = processed.replace(/import\s*\(["']([^"']+)["']\)/g, (match, url) => {
        const resolved = normalizePath(htmlPath, url);
        if (resolved && blobUrls.has(resolved)) {
          return `import("${blobUrls.get(resolved)}")`;
        }
        return match;
      });

      // Inject the patch script right after <head>
      const patchScript = createPatchScript(blobUrls);
      if (processed.includes('<head>')) {
        processed = processed.replace('<head>', '<head>' + patchScript);
      } else if (processed.includes('<HEAD>')) {
        processed = processed.replace('<HEAD>', '<HEAD>' + patchScript);
      } else {
        // Prepend if no head tag
        processed = patchScript + processed;
      }

      return processed;
    }

    // Process CSS files
    async function processCss(cssPath) {
      const blob = files.get(cssPath);
      const text = await blob.text();

      // Replace url() in CSS
      let processed = text.replace(/url\(["']?([^"')]+)["']?\)/gi, (match, url) => {
        const resolved = normalizePath(cssPath, url);
        if (resolved && blobUrls.has(resolved)) {
          return `url("${blobUrls.get(resolved)}")`;
        }
        return match;
      });

      return processed;
    }

    // Process and update blob URLs for CSS files
    for (const [path, blob] of files) {
      if (path.endsWith('.css')) {
        const processedCss = await processCss(path);
        const newBlob = new Blob([processedCss], { type: 'text/css' });
        const newUrl = URL.createObjectURL(newBlob);
        URL.revokeObjectURL(blobUrls.get(path));
        blobUrls.set(path, newUrl);
        createdBlobUrls.push(newUrl);
      }
    }

    // Process index.html
    const processedHtml = await processHtml(indexPath, blobUrls);

    // Create blob URL for processed HTML
    const htmlBlob = new Blob([processedHtml], { type: 'text/html' });
    const htmlUrl = URL.createObjectURL(htmlBlob);
    createdBlobUrls.push(htmlUrl);

    // Show the report
    hideLoading();
    mainContainer.style.display = 'none';
    reportFrame.src = htmlUrl;
    reportFrame.classList.add('active');
    backButton.classList.add('active');

  } catch (err) {
    console.error('Error:', err);
    showError(`Failed to load report: ${err.message}`);
  }
}

// Check for URL parameter on page load
const urlParams = new URLSearchParams(window.location.search);
const urlParam = urlParams.get('url');
if (urlParam) {
  urlInput.value = urlParam;
  loadFromUrl();
}
