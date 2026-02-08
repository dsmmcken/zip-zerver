/**
 * WebGL Drag-Over Animation with Zipper Unzip Effect
 * Self-contained module - no dependencies on main application
 * Shows animated "DROP" text at 45° when dragging files
 * Shows percentage during extraction, then unzips to reveal iframe
 */
(function() {
  'use strict';

  const TEXT = 'DROP ';
  const FONT_SIZE = 14;
  const ROW_HEIGHT = 24;
  const ROTATION = -Math.PI / 4; // -45 degrees
  const LERP_FACTOR = 0.08;
  const PAN_SCALE = 0.5;
  const BG_COLOR = { r: 0.03, g: 0.07, b: 0.72 };

  // Animation constants
  const UNZIP_DURATION = 1200; // ms for the split animation
  const DROP_FADE_DURATION = 300; // ms to fade out DROP text

  // State machine
  const State = {
    IDLE: 'IDLE',
    DRAGGING: 'DRAGGING',
    EXTRACTING: 'EXTRACTING',
    UNZIPPING: 'UNZIPPING'
  };

  // Create and insert canvas
  const canvas = document.createElement('canvas');
  canvas.id = 'drag-overlay-canvas';
  document.body.appendChild(canvas);

  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false });
  if (!gl) {
    console.warn('WebGL not supported, drag overlay disabled');
    return;
  }

  // === SHADER SOURCES ===

  // Drag shader (rotating text pattern)
  const dragVertexShaderSource = `
    attribute vec2 a_position;
    attribute vec2 a_texCoord;
    uniform vec2 u_resolution;
    uniform float u_rotation;
    uniform vec2 u_pan;
    varying vec2 v_texCoord;

    void main() {
      vec2 center = u_resolution * 0.5;
      vec2 pos = a_position + u_pan - center;
      float c = cos(u_rotation);
      float s = sin(u_rotation);
      vec2 rotated = vec2(pos.x * c - pos.y * s, pos.x * s + pos.y * c);
      rotated += center;
      vec2 clipSpace = (rotated / u_resolution) * 2.0 - 1.0;
      gl_Position = vec4(clipSpace * vec2(1, -1), 0, 1);
      v_texCoord = a_texCoord;
    }
  `;

  const dragFragmentShaderSource = `
    precision mediump float;
    uniform sampler2D u_texture;
    uniform float u_opacity;
    uniform vec3 u_color;
    uniform float u_gradientDir; // 0 = none, 1 = fade top edge, -1 = fade bottom edge
    uniform float u_fadeAmount;  // 0-1, portion of edge to fade (based on movement offset)
    varying vec2 v_texCoord;

    void main() {
      vec4 texColor = texture2D(u_texture, v_texCoord);
      float alpha = texColor.a * u_opacity;

      // Apply gradient mask - strong fade at edges
      if (u_gradientDir > 0.5 && u_fadeAmount > 0.0) {
        // Fade top edge: v=0 is top, v=1 is bottom
        float fadeZone = u_fadeAmount;
        if (v_texCoord.y < fadeZone) {
          float t = v_texCoord.y / fadeZone;
          // Use power curve for stronger edge fade
          alpha *= t * t * t;
        }
      } else if (u_gradientDir < -0.5 && u_fadeAmount > 0.0) {
        // Fade bottom edge
        float fadeZone = u_fadeAmount;
        float distFromBottom = 1.0 - v_texCoord.y;
        if (distFromBottom < fadeZone) {
          float t = distFromBottom / fadeZone;
          // Use power curve for stronger edge fade
          alpha *= t * t * t;
        }
      }

      gl_FragColor = vec4(u_color, alpha);
    }
  `;

  // Split shader - renders from framebuffer texture with zipper unzip effect
  const splitVertexShaderSource = `
    attribute vec2 a_position;
    varying vec2 v_texCoord;

    void main() {
      gl_Position = vec4(a_position, 0, 1);
      v_texCoord = (a_position + 1.0) * 0.5;
    }
  `;

  const splitFragmentShaderSource = `
    precision mediump float;
    uniform sampler2D u_texture;
    uniform float u_progress;
    varying vec2 v_texCoord;

    // Ease in cubic
    float easeInCubic(float t) {
      t = clamp(t, 0.0, 1.0);
      return t * t * t;
    }

    void main() {
      vec2 uv = v_texCoord;

      // Staggered curtain: top starts first, bottom follows
      // uv.y = 0 is bottom, uv.y = 1 is top in GL coordinates
      float stagger = 0.7;
      float localProgress = u_progress * (1.0 + stagger) - (1.0 - uv.y) * stagger;

      // Apply ease-in to this row's progress
      float easedProgress = easeInCubic(localProgress);

      // Split distance: 0 = center, 0.5 = edge of screen
      float splitDist = easedProgress * 0.52;

      // Square wave zipper teeth pattern
      float teethFreq = 35.0;
      float teethAmp = 0.012;

      // Square wave: alternates between 0 and 1
      float squareWave = step(0.5, fract(uv.y * teethFreq));
      float zipper = (squareWave - 0.5) * teethAmp;

      // Edge position with zipper teeth
      float edgeLeft = 0.5 + zipper;
      float edgeRight = 0.5 - zipper;

      // Determine which half and shift
      if (uv.x < 0.5) {
        // Left half - pull left
        vec2 sampleUV = uv;
        sampleUV.x += splitDist;

        // In the gap? (use zipper edge)
        if (sampleUV.x >= edgeLeft) {
          gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
          return;
        }
        gl_FragColor = texture2D(u_texture, sampleUV);
      } else {
        // Right half - pull right
        vec2 sampleUV = uv;
        sampleUV.x -= splitDist;

        // In the gap? (use zipper edge)
        if (sampleUV.x < edgeRight) {
          gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
          return;
        }
        gl_FragColor = texture2D(u_texture, sampleUV);
      }
    }
  `;

  // === SHADER COMPILATION ===

  function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Shader compile error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  function createProgram(gl, vertexShader, fragmentShader) {
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return null;
    }
    return program;
  }

  // Create programs
  const dragProgram = createProgram(gl,
    createShader(gl, gl.VERTEX_SHADER, dragVertexShaderSource),
    createShader(gl, gl.FRAGMENT_SHADER, dragFragmentShaderSource)
  );

  const splitProgram = createProgram(gl,
    createShader(gl, gl.VERTEX_SHADER, splitVertexShaderSource),
    createShader(gl, gl.FRAGMENT_SHADER, splitFragmentShaderSource)
  );

  // Program locations
  const dragLocs = {
    position: gl.getAttribLocation(dragProgram, 'a_position'),
    texCoord: gl.getAttribLocation(dragProgram, 'a_texCoord'),
    resolution: gl.getUniformLocation(dragProgram, 'u_resolution'),
    rotation: gl.getUniformLocation(dragProgram, 'u_rotation'),
    pan: gl.getUniformLocation(dragProgram, 'u_pan'),
    texture: gl.getUniformLocation(dragProgram, 'u_texture'),
    opacity: gl.getUniformLocation(dragProgram, 'u_opacity'),
    color: gl.getUniformLocation(dragProgram, 'u_color'),
    gradientDir: gl.getUniformLocation(dragProgram, 'u_gradientDir'),
    fadeAmount: gl.getUniformLocation(dragProgram, 'u_fadeAmount')
  };

  // Colors
  const WHITE = [1.0, 1.0, 1.0];
  const GRAY4 = [0.44, 0.44, 0.44]; // #707070 = rgb(112,112,112) / 255

  const splitLocs = {
    position: gl.getAttribLocation(splitProgram, 'a_position'),
    texture: gl.getUniformLocation(splitProgram, 'u_texture'),
    progress: gl.getUniformLocation(splitProgram, 'u_progress')
  };

  // Buffers
  const positionBuffer = gl.createBuffer();
  const texCoordBuffer = gl.createBuffer();
  const quadBuffer = gl.createBuffer();

  // Full-screen quad for split shader
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, 1, -1, -1, 1,
    1, -1, 1, 1, -1, 1
  ]), gl.STATIC_DRAW);

  // Framebuffer for render-to-texture
  let framebuffer = null;
  let framebufferTexture = null;

  function setupFramebuffer() {
    if (framebuffer) {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(framebufferTexture);
    }

    framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);

    framebufferTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, framebufferTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, canvas.width, canvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, framebufferTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Character atlas (small - for DROP text)
  let charData = {};
  let atlasTexture = null;
  let atlasWidth = 0;
  let atlasHeight = 0;

  // Large character atlas (for percentage - Spline Sans Mono)
  const LARGE_FONT_SIZE = 80;
  let largeCharData = {};
  let largeAtlasTexture = null;
  let largeAtlasWidth = 0;
  let largeAtlasHeight = 0;

  // Work Sans atlas (for UNZIP subtitle)
  const SUBTITLE_FONT_SIZE = 28;
  let subtitleCharData = {};
  let subtitleAtlasTexture = null;
  let subtitleAtlasWidth = 0;
  let subtitleAtlasHeight = 0;

  // State
  let currentState = State.IDLE;
  let isVisible = false;
  let isDisabled = false;
  let dragEnterCount = 0;
  let dpr = 1;
  let animationId = null;
  let lastTime = 0;
  let rowOffsets = [];

  // Pan state
  let currentPanX = 0;
  let currentPanY = 0;
  let targetPanX = 0;
  let targetPanY = 0;
  let mouseX = 0;
  let mouseY = 0;

  // Animation state
  let extractionProgress = 0;
  let unzipStartTime = 0;
  let extractionStartTime = 0;
  let iframeLoaded = false;

  // Rolling digit animation state
  let displayedDigits = [0, 0]; // [tens, ones] for percentage
  let digitOffsets = [0, 0]; // Y offset for rolling animation

  // Create character atlas with digits and symbols
  function createCharacterAtlas() {
    // Small atlas for DROP text
    const allChars = TEXT + '0123456789.%';
    const uniqueChars = [...new Set(allChars)];
    const offscreenCanvas = document.createElement('canvas');
    const ctx = offscreenCanvas.getContext('2d');

    ctx.font = `600 ${FONT_SIZE}px 'Spline Sans Mono', monospace`;

    let totalWidth = 0;
    const charMetrics = {};
    for (const char of uniqueChars) {
      const metrics = ctx.measureText(char);
      charMetrics[char] = {
        width: Math.ceil(metrics.width) + 4,
        height: FONT_SIZE + 8
      };
      totalWidth += charMetrics[char].width;
    }

    atlasWidth = Math.pow(2, Math.ceil(Math.log2(totalWidth)));
    atlasHeight = Math.pow(2, Math.ceil(Math.log2(FONT_SIZE + 8)));

    offscreenCanvas.width = atlasWidth;
    offscreenCanvas.height = atlasHeight;

    ctx.font = `600 ${FONT_SIZE}px 'Spline Sans Mono', monospace`;
    ctx.fillStyle = 'white';
    ctx.textBaseline = 'middle';

    let x = 0;
    for (const char of uniqueChars) {
      const m = charMetrics[char];
      ctx.fillText(char, x + 2, atlasHeight / 2);
      charData[char] = {
        x: x,
        width: m.width,
        u0: x / atlasWidth,
        u1: (x + m.width) / atlasWidth,
        v0: 0,
        v1: 1
      };
      x += m.width;
    }

    atlasTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, offscreenCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // Large atlas for percentage display
    createLargeCharacterAtlas();
  }

  function createLargeCharacterAtlas() {
    const percentChars = '0123456789%UNZIPG.';
    const offscreenCanvas = document.createElement('canvas');
    const ctx = offscreenCanvas.getContext('2d');

    ctx.font = `600 ${LARGE_FONT_SIZE}px 'Spline Sans Mono', monospace`;

    let totalWidth = 0;
    const charMetrics = {};
    for (const char of percentChars) {
      const metrics = ctx.measureText(char);
      charMetrics[char] = {
        width: Math.ceil(metrics.width) + 8,
        height: LARGE_FONT_SIZE + 16
      };
      totalWidth += charMetrics[char].width;
    }

    largeAtlasWidth = Math.pow(2, Math.ceil(Math.log2(totalWidth)));
    largeAtlasHeight = Math.pow(2, Math.ceil(Math.log2(LARGE_FONT_SIZE + 16)));

    offscreenCanvas.width = largeAtlasWidth;
    offscreenCanvas.height = largeAtlasHeight;

    ctx.font = `600 ${LARGE_FONT_SIZE}px 'Spline Sans Mono', monospace`;
    ctx.fillStyle = 'white';
    ctx.textBaseline = 'middle';

    let x = 0;
    for (const char of percentChars) {
      const m = charMetrics[char];
      ctx.fillText(char, x + 4, largeAtlasHeight / 2);
      largeCharData[char] = {
        x: x,
        width: m.width,
        u0: x / largeAtlasWidth,
        u1: (x + m.width) / largeAtlasWidth,
        v0: 0,
        v1: 1
      };
      x += m.width;
    }

    largeAtlasTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, largeAtlasTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, offscreenCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // Create Work Sans atlas for subtitle
    createSubtitleAtlas();
  }

  function createSubtitleAtlas() {
    const subtitleChars = 'Unzipng';
    const offscreenCanvas = document.createElement('canvas');
    const ctx = offscreenCanvas.getContext('2d');

    ctx.font = `400 ${SUBTITLE_FONT_SIZE}px 'Work Sans', sans-serif`;

    let totalWidth = 0;
    const charMetrics = {};
    for (const char of subtitleChars) {
      const metrics = ctx.measureText(char);
      charMetrics[char] = {
        width: Math.ceil(metrics.width) + 8,
        height: SUBTITLE_FONT_SIZE + 16
      };
      totalWidth += charMetrics[char].width;
    }

    subtitleAtlasWidth = Math.pow(2, Math.ceil(Math.log2(totalWidth)));
    subtitleAtlasHeight = Math.pow(2, Math.ceil(Math.log2(SUBTITLE_FONT_SIZE + 16)));

    offscreenCanvas.width = subtitleAtlasWidth;
    offscreenCanvas.height = subtitleAtlasHeight;

    ctx.font = `400 ${SUBTITLE_FONT_SIZE}px 'Work Sans', sans-serif`;
    ctx.fillStyle = 'white';
    ctx.textBaseline = 'middle';

    let x = 0;
    for (const char of subtitleChars) {
      const m = charMetrics[char];
      ctx.fillText(char, x + 4, subtitleAtlasHeight / 2);
      subtitleCharData[char] = {
        x: x,
        width: m.width,
        u0: x / subtitleAtlasWidth,
        u1: (x + m.width) / subtitleAtlasWidth,
        v0: 0,
        v1: 1
      };
      x += m.width;
    }

    subtitleAtlasTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, subtitleAtlasTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, offscreenCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  function getTextWidth(text) {
    let width = 0;
    for (const char of text) {
      width += (charData[char]?.width || 10) * dpr;
    }
    return width;
  }

  // Build geometry for text pattern (used for both DROP and percentage)
  function buildPatternGeometry(text, applyPan) {
    const positions = [];
    const texCoords = [];

    const w = canvas.width;
    const h = canvas.height;
    const panMargin = Math.max(w, h) * PAN_SCALE;
    const diagonal = Math.sqrt(w * w + h * h) + panMargin * 2;
    const rowHeightScaled = ROW_HEIGHT * dpr;
    const numRows = Math.ceil(diagonal / rowHeightScaled) + 4;
    const textWidth = getTextWidth(text);
    const halfHeight = ((FONT_SIZE + 8) / 2) * dpr;

    const centerX = w / 2;
    const centerY = h / 2;

    while (rowOffsets.length < numRows) {
      rowOffsets.push(0);
    }

    for (let row = 0; row < numRows; row++) {
      const rowY = centerY + (row - numRows / 2) * rowHeightScaled;
      const offset = applyPan ? rowOffsets[row] : 0;
      const repsNeeded = Math.ceil(diagonal / textWidth) + 4;
      const rowOffset = row % 2 === 0 ? 0 : textWidth / 2;
      let startX = centerX - diagonal / 2 - textWidth + (offset % textWidth) + rowOffset;

      for (let rep = 0; rep < repsNeeded; rep++) {
        let charX = startX + rep * textWidth;

        for (const char of text) {
          const cd = charData[char];
          if (!cd) continue;

          const charWidth = cd.width * dpr;
          const x0 = charX;
          const x1 = charX + charWidth;
          const y0 = rowY - halfHeight;
          const y1 = rowY + halfHeight;

          positions.push(x0, y0, x1, y0, x0, y1, x1, y0, x1, y1, x0, y1);
          texCoords.push(cd.u0, cd.v0, cd.u1, cd.v0, cd.u0, cd.v1, cd.u1, cd.v0, cd.u1, cd.v1, cd.u0, cd.v1);

          charX += charWidth;
        }
      }
    }

    return { positions, texCoords };
  }

  function formatPercentage(progress) {
    const percent = Math.floor(progress * 100);
    if (percent >= 100) return '100%';
    return percent.toString().padStart(2, '0') + '%';
  }

  // Helper to render a single character
  // gradientDir: 0 = none, 1 = fade top edge, -1 = fade bottom edge
  // fadeAmount: 0-1, portion of edge to fade (based on movement offset)
  function renderChar(char, x, y, halfHeight, scale, charData, opacity, color = WHITE, gradientDir = 0, fadeAmount = 0) {
    const cd = charData[char];
    if (!cd) return 0;

    const cw = cd.width * dpr * scale;
    const hh = halfHeight * scale;

    const positions = [
      x, y - hh, x + cw, y - hh, x, y + hh,
      x + cw, y - hh, x + cw, y + hh, x, y + hh
    ];
    const texCoords = [
      cd.u0, cd.v0, cd.u1, cd.v0, cd.u0, cd.v1,
      cd.u1, cd.v0, cd.u1, cd.v1, cd.u0, cd.v1
    ];

    gl.uniform1f(dragLocs.opacity, opacity);
    gl.uniform3fv(dragLocs.color, color);
    gl.uniform1f(dragLocs.gradientDir, gradientDir);
    gl.uniform1f(dragLocs.fadeAmount, fadeAmount);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(dragLocs.position);
    gl.vertexAttribPointer(dragLocs.position, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(texCoords), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(dragLocs.texCoord);
    gl.vertexAttribPointer(dragLocs.texCoord, 2, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return cw;
  }

  // Easing function for smooth digit rolling
  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  // Render percentage with rolling digit animation
  function renderRollingPercentage(time, baseOpacity) {
    const targetPercent = Math.min(100, Math.floor(extractionProgress * 100));
    const targetTens = Math.floor(targetPercent / 10);
    const targetOnes = targetPercent % 10;

    // Animate digits rolling
    const rollSpeed = 0.08; // Slower linear speed, easing makes it feel right

    // Update displayed digits with rolling animation
    for (let i = 0; i < 2; i++) {
      const target = i === 0 ? targetTens : targetOnes;
      const current = displayedDigits[i];

      if (current !== target) {
        digitOffsets[i] += rollSpeed;

        if (digitOffsets[i] >= 1) {
          digitOffsets[i] = 0;
          displayedDigits[i] = (current + 1) % 10;
          if (i === 0 && targetPercent >= 100) {
            displayedDigits[i] = Math.min(displayedDigits[i], 10);
          }
        }
      }
    }

    const w = canvas.width;
    const h = canvas.height;
    const mainHeight = (LARGE_FONT_SIZE + 16) * dpr;
    const subTextHeight = (SUBTITLE_FONT_SIZE + 16) * dpr;
    const gap = 20 * dpr;
    const totalHeight = mainHeight + gap + subTextHeight;
    const startY = h / 2 - totalHeight / 2 + mainHeight / 2;
    const halfHeight = mainHeight / 2;

    const digitWidth = (largeCharData['0']?.width || 10) * dpr;
    const percentWidth = (largeCharData['%']?.width || 10) * dpr;

    const is100 = targetPercent >= 100 && displayedDigits[0] >= 10;

    let totalWidth = is100 ? digitWidth * 3 + percentWidth : digitWidth * 2 + percentWidth;
    let charX = (w - totalWidth) / 2;
    const charY = startY;

    // Setup GL state
    gl.useProgram(dragProgram);
    gl.uniform2f(dragLocs.resolution, canvas.width, canvas.height);
    gl.uniform1f(dragLocs.rotation, 0);
    gl.uniform2f(dragLocs.pan, 0, 0);
    gl.uniform3fv(dragLocs.color, WHITE);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, largeAtlasTexture);
    gl.uniform1i(dragLocs.texture, 0);

    if (is100) {
      // Render "100%" static (no gradient)
      for (const char of ['1', '0', '0', '%']) {
        charX += renderChar(char, charX, charY, halfHeight, 1, largeCharData, baseOpacity, WHITE, 0, 0);
      }
    } else {
      // Render rolling digits with gradient masks and easing
      for (let i = 0; i < 2; i++) {
        const digit = displayedDigits[i];
        const nextDigit = (digit + 1) % 10;
        const offset = digitOffsets[i];

        // Apply easing to visual position
        const easedOffset = easeInOutCubic(offset);
        const rollHeight = mainHeight * 0.7; // tighter vertical spacing during roll
        const yOffset = easedOffset * rollHeight;

        // Current digit (rolling up/out) - fade top edge based on eased offset
        // gradientDir = 1 means fade top edge, use larger fadeAmount for stronger gradient
        const fadeOut = Math.min(1, easedOffset * 1.5);
        renderChar(digit.toString(), charX, charY - yOffset, halfHeight, 1, largeCharData, baseOpacity, WHITE, 1, fadeOut);

        // Next digit (rolling in from below) - fade bottom edge
        if (offset > 0) {
          const nextY = charY + rollHeight - yOffset;
          // gradientDir = -1 means fade bottom edge
          const fadeIn = Math.min(1, (1 - easedOffset) * 1.5);
          renderChar(nextDigit.toString(), charX, nextY, halfHeight, 1, largeCharData, baseOpacity, WHITE, -1, fadeIn);
        }

        charX += digitWidth;
      }

      // Render % sign (no gradient)
      renderChar('%', charX, charY, halfHeight, 1, largeCharData, baseOpacity, WHITE, 0, 0);
    }

    // Render Unzipping subtitle in gray using Work Sans atlas
    const subChars = 'Unzipping';
    let subWidth = 0;
    for (const char of subChars) {
      subWidth += (subtitleCharData[char]?.width || 10) * dpr;
    }
    charX = (w - subWidth) / 2;
    const subY = startY + mainHeight / 2 + gap + subTextHeight / 2;

    // Switch to subtitle atlas
    gl.bindTexture(gl.TEXTURE_2D, subtitleAtlasTexture);

    for (const char of subChars) {
      charX += renderChar(char, charX, subY, subTextHeight / 2, 1, subtitleCharData, baseOpacity, GRAY4);
    }

    // Switch back to large atlas
    gl.bindTexture(gl.TEXTURE_2D, largeAtlasTexture);
  }

  // Calculate layout positions for percentage + subtitle
  function getTextLayout() {
    const w = canvas.width;
    const h = canvas.height;
    const mainHeight = (LARGE_FONT_SIZE + 16) * dpr;
    const subTextHeight = (SUBTITLE_FONT_SIZE + 16) * dpr;
    const gap = 20 * dpr;

    const totalHeight = mainHeight + gap + subTextHeight;
    const startY = h / 2 - totalHeight / 2 + mainHeight / 2;

    return {
      w, h,
      mainHeight,
      subTextHeight,
      gap,
      mainY: startY,
      subY: startY + mainHeight / 2 + gap + subTextHeight / 2
    };
  }

  // Render large centered text with Work Sans subtitle
  function renderLargeText(text, subtitle, opacity = 1.0) {
    const layout = getTextLayout();

    gl.useProgram(dragProgram);
    gl.uniform2f(dragLocs.resolution, canvas.width, canvas.height);
    gl.uniform1f(dragLocs.rotation, 0);
    gl.uniform2f(dragLocs.pan, 0, 0);

    // Render main text (percentage) with large atlas
    let totalWidth = 0;
    for (const char of text) {
      totalWidth += (largeCharData[char]?.width || 10) * dpr;
    }
    let charX = (layout.w - totalWidth) / 2;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, largeAtlasTexture);
    gl.uniform1i(dragLocs.texture, 0);

    for (const char of text) {
      charX += renderChar(char, charX, layout.mainY, layout.mainHeight / 2, 1, largeCharData, opacity, WHITE);
    }

    // Render subtitle with Work Sans atlas
    if (subtitle) {
      let subWidth = 0;
      for (const char of subtitle) {
        subWidth += (subtitleCharData[char]?.width || 10) * dpr;
      }
      charX = (layout.w - subWidth) / 2;

      gl.bindTexture(gl.TEXTURE_2D, subtitleAtlasTexture);

      for (const char of subtitle) {
        charX += renderChar(char, charX, layout.subY, layout.subTextHeight / 2, 1, subtitleCharData, opacity, GRAY4);
      }
    }
  }

  // Resize handler
  function resize() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    gl.viewport(0, 0, canvas.width, canvas.height);
    setupFramebuffer();
  }

  // Render rotated text pattern
  function renderPattern(text, applyPan, opacity = 1.0) {
    const { positions, texCoords } = buildPatternGeometry(text, applyPan);
    if (positions.length === 0) return;

    gl.useProgram(dragProgram);
    gl.uniform2f(dragLocs.resolution, canvas.width, canvas.height);
    gl.uniform1f(dragLocs.rotation, ROTATION);
    gl.uniform2f(dragLocs.pan, applyPan ? currentPanX * dpr : 0, applyPan ? currentPanY * dpr : 0);
    gl.uniform1f(dragLocs.opacity, opacity);
    gl.uniform3fv(dragLocs.color, WHITE);
    gl.uniform1f(dragLocs.gradientDir, 0); // No gradient for pattern text
    gl.uniform1f(dragLocs.fadeAmount, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
    gl.uniform1i(dragLocs.texture, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(dragLocs.position);
    gl.vertexAttribPointer(dragLocs.position, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(texCoords), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(dragLocs.texCoord);
    gl.vertexAttribPointer(dragLocs.texCoord, 2, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLES, 0, positions.length / 2);
  }

  // Render DRAGGING state
  function renderDragging(time) {
    const deltaTime = lastTime ? (time - lastTime) / 1000 : 0;
    lastTime = time;

    currentPanX += (targetPanX - currentPanX) * LERP_FACTOR;
    currentPanY += (targetPanY - currentPanY) * LERP_FACTOR;

    gl.clearColor(BG_COLOR.r, BG_COLOR.g, BG_COLOR.b, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    renderPattern(TEXT, true, 1.0);
  }

  // Render EXTRACTING state (large centered percentage)
  function renderExtracting(time) {
    // Fade out DROP text during transition
    const fadeElapsed = time - extractionStartTime;
    const fadeProgress = Math.min(1, fadeElapsed / DROP_FADE_DURATION);

    // Transition background from blue to black
    const r = BG_COLOR.r * (1 - fadeProgress);
    const g = BG_COLOR.g * (1 - fadeProgress);
    const b = BG_COLOR.b * (1 - fadeProgress);
    gl.clearColor(r, g, b, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    if (fadeProgress < 1) {
      // Still fading - render DROP text with decreasing opacity
      renderPattern(TEXT, false, 1 - fadeProgress);
    }

    // Render percentage with rolling digits
    renderRollingPercentage(time, fadeProgress);
  }

  // Render to framebuffer (black + large 100%)
  function renderToFramebuffer(textOpacity = 1.0) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, canvas.width, canvas.height);

    gl.clearColor(0, 0, 0, 1.0); // Black background
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    renderLargeText('100%', 'Unzipping', textOpacity);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Render UNZIPPING state (split effect)
  function renderUnzipping(time) {
    const elapsed = time - unzipStartTime;
    const progress = Math.min(1, elapsed / UNZIP_DURATION);
    const eased = 1 - Math.pow(1 - progress, 3); // easeOutCubic

    // Fade text to black as unzip progresses (twice as fast)
    const textOpacity = Math.max(0, 1 - eased * 2);

    // First render black + text to framebuffer
    renderToFramebuffer(textOpacity);

    // Now render split effect to screen
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(splitProgram);
    gl.uniform1f(splitLocs.progress, eased);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, framebufferTexture);
    gl.uniform1i(splitLocs.texture, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.enableVertexAttribArray(splitLocs.position);
    gl.vertexAttribPointer(splitLocs.position, 2, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    if (progress >= 1) {
      completeReveal();
    }
  }

  function completeReveal() {
    canvas.classList.remove('active');
    isVisible = false;

    const reportFrame = document.querySelector('.report-frame');
    if (reportFrame) {
      reportFrame.classList.add('active');
    }

    resetState();
  }

  function resetState() {
    currentState = State.IDLE;
    extractionProgress = 0;
    unzipStartTime = 0;
    iframeLoaded = false;
    dragEnterCount = 0;
  }

  // Animation loop
  function render(time) {
    if (!isVisible) {
      animationId = null;
      return;
    }

    switch (currentState) {
      case State.DRAGGING:
        renderDragging(time);
        break;

      case State.EXTRACTING:
        renderExtracting(time);
        // Check if extraction complete and iframe loaded
        if (extractionProgress >= 1 && iframeLoaded) {
          currentState = State.UNZIPPING;
          unzipStartTime = time;
          // Show iframe behind canvas
          const reportFrame = document.querySelector('.report-frame');
          if (reportFrame) {
            reportFrame.classList.add('active');
          }
        }
        break;

      case State.UNZIPPING:
        renderUnzipping(time);
        break;
    }

    animationId = requestAnimationFrame(render);
  }

  function getPanFromCursor() {
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;
    return {
      x: (mouseX - centerX) * PAN_SCALE,
      y: (mouseY - centerY) * PAN_SCALE
    };
  }

  function show() {
    if (isVisible) return;
    isVisible = true;
    currentState = State.DRAGGING;
    canvas.classList.add('active');
    lastTime = 0;
    const initialPan = getPanFromCursor();
    currentPanX = initialPan.x;
    currentPanY = initialPan.y;
    targetPanX = initialPan.x;
    targetPanY = initialPan.y;
    animationId = requestAnimationFrame(render);
  }

  function hide() {
    isVisible = false;
    canvas.classList.remove('active');
    if (animationId) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }
    resetState();
  }

  // === PUBLIC API ===

  function startUnzip() {
    if (currentState !== State.DRAGGING) return false;
    currentState = State.EXTRACTING;
    extractionStartTime = performance.now();
    extractionProgress = 0;
    iframeLoaded = false;
    // Reset rolling digits
    displayedDigits = [0, 0];
    digitOffsets = [0, 0];
    return true;
  }

  function setProgress(progress) {
    extractionProgress = Math.max(0, Math.min(1, progress));
  }

  function complete() {
    iframeLoaded = true;
  }

  function abort() {
    hide();
  }

  window.dragOverlay = {
    startUnzip,
    setProgress,
    complete,
    abort
  };

  // === EVENT HANDLERS ===

  function handleDragEnter(e) {
    e.preventDefault();
    if (isDisabled) return;
    if (currentState !== State.IDLE && currentState !== State.DRAGGING) return;

    dragEnterCount++;
    if (dragEnterCount === 1) {
      mouseX = e.clientX;
      mouseY = e.clientY;
      show();
    }
  }

  function handleDragLeave(e) {
    e.preventDefault();
    if (currentState !== State.DRAGGING) return;

    dragEnterCount--;
    if (dragEnterCount === 0) {
      hide();
    }
  }

  function handleDragOver(e) {
    e.preventDefault();
    if (currentState !== State.DRAGGING) return;

    mouseX = e.clientX;
    mouseY = e.clientY;
    const pan = getPanFromCursor();
    targetPanX = pan.x;
    targetPanY = pan.y;
  }

  function handleDrop(e) {
    dragEnterCount = 0;
  }

  function init() {
    resize();
    createCharacterAtlas();

    window.addEventListener('dragenter', handleDragEnter);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('drop', handleDrop);
    window.addEventListener('resize', resize);
  }

  function disable() {
    if (isDisabled) return;
    isDisabled = true;
    hide();
  }

  function enable() {
    if (!isDisabled) return;
    isDisabled = false;
  }

  const observer = new MutationObserver(() => {
    const reportFrame = document.querySelector('.report-frame');
    if (reportFrame && reportFrame.classList.contains('active')) {
      if (currentState === State.IDLE || currentState === State.DRAGGING) {
        disable();
      }
    } else if (isDisabled) {
      enable();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class']
  });

  // Simulate unzip animation with 'z' key
  let simulationStartTime = 0;
  const SIMULATION_DURATION = 3000; // 3 seconds

  function simulateUnzip() {
    if (currentState !== State.IDLE) return;

    // Show canvas and start extraction
    isVisible = true;
    canvas.classList.add('active');
    currentState = State.EXTRACTING;
    extractionStartTime = performance.now();
    simulationStartTime = performance.now();
    extractionProgress = 0;
    iframeLoaded = false;
    displayedDigits = [0, 0];
    digitOffsets = [0, 0];

    // Start animation loop
    animationId = requestAnimationFrame(render);

    // Animate progress over 3 seconds
    function updateSimulation() {
      const elapsed = performance.now() - simulationStartTime;
      const progress = Math.min(1, elapsed / SIMULATION_DURATION);
      extractionProgress = progress;

      if (progress >= 1) {
        // Mark as complete and trigger unzip
        iframeLoaded = true;
      } else {
        requestAnimationFrame(updateSimulation);
      }
    }
    requestAnimationFrame(updateSimulation);
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'z' || e.key === 'Z') {
      simulateUnzip();
    }
  });

  if (document.fonts && document.fonts.load) {
    document.fonts.load("600 14px 'Spline Sans Mono'").then(init).catch(() => {
      setTimeout(init, 500);
    });
  } else {
    setTimeout(init, 500);
  }
})();
