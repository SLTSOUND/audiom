"use strict";

(function () {
  const deviceSelect = document.getElementById("deviceSelect");
  const refreshBtn = document.getElementById("refreshBtn");
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const statusText = document.getElementById("statusText");
  const playbackStatus = document.getElementById("playbackStatus");
  const metaInfo = document.getElementById("metaInfo");
  const spectrumCanvas = document.getElementById("spectrumCanvas");
  const vuCanvas = document.getElementById("vuCanvas");
  const rmsDbEl = document.getElementById("rmsDb");
  const peakDbEl = document.getElementById("peakDb");
  const yearEl = document.getElementById("year");
  const outputSelect = document.getElementById("outputSelect");
  const monitorBtn = document.getElementById("monitorBtn");
  const monitorGainSlider = document.getElementById("monitorGain");
  const usbRefreshBtn = document.getElementById("usbRefreshBtn");
  const deviceCountEl = document.getElementById("deviceCount");

  yearEl.textContent = new Date().getFullYear().toString();

  let audioContext = null;
  let mediaStream = null;
  let mediaSourceNode = null;
  let analyserNode = null;
  let channelSplitter = null; // reserved for future stereo vu

  // Monitoring graph
  let monitorGainNode = null;
  let monitorDestination = null; // audioContext.destination
  let monitorEnabled = true; // Changed to true for default monitoring
  let htmlAudioForRouting = null; // for setSinkId support

  // Device tracking
  let lastDeviceCount = { inputs: 0, outputs: 0 };

  // Drawing state
  let animationFrameHandle = null;
  let deviceIdInUse = null;
  let isRunning = false;

  // Spectrum settings
  const spectrumConfig = {
    fftSize: 4096,
    minDecibels: -90,
    maxDecibels: -10,
    smoothingTimeConstant: 0.85,
    barCount: 96,
    peakHoldFallDbPerSec: 24,
  };

  // Canvas 2D contexts
  const spectrumCtx = spectrumCanvas.getContext("2d");
  const vuCtx = vuCanvas.getContext("2d");

  // HiDPI helpers
  function resizeCanvasToDisplaySize(canvas) {
    const ratio = Math.max(1, Math.floor(window.devicePixelRatio || 1));
    const { clientWidth, clientHeight } = canvas;
    if (!clientWidth || !clientHeight) return;
    const needResize = canvas.width !== clientWidth * ratio || canvas.height !== clientHeight * ratio;
    if (needResize) {
      canvas.width = clientWidth * ratio;
      canvas.height = clientHeight * ratio;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function linearToDbFS(value) {
    const v = Math.max(value, 1e-12);
    return 20 * Math.log10(v);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function formatDb(db) {
    if (!isFinite(db)) return "-∞ dBFS";
    return `${db.toFixed(1)} dBFS`;
  }

  async function ensurePermissions() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
    } catch (err) {
      console.warn("Microphone permission might be denied.", err);
    }
  }

  async function enumerateAudioInputDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      let inputs = devices.filter(d => d.kind === "audioinput");

      // Enhanced sorting: USB devices first, then default, then others
      inputs.sort((a, b) => {
        const aIsUsb = isUsbDevice(a);
        const bIsUsb = isUsbDevice(b);
        const aIsDefault = a.deviceId === "default";
        const bIsDefault = b.deviceId === "default";
        
        // USB devices first
        if (aIsUsb && !bIsUsb) return -1;
        if (!aIsUsb && bIsUsb) return 1;
        
        // Then default device
        if (aIsDefault && !bIsDefault) return -1;
        if (!aIsDefault && bIsDefault) return 1;
        
        // Then alphabetically
        return (a.label || "").localeCompare(b.label || "");
      });

      // Preserve selection
      const previous = deviceSelect.value;
      deviceSelect.innerHTML = "";

      if (inputs.length === 0) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "No input devices found";
        deviceSelect.appendChild(opt);
        deviceSelect.disabled = true;
        return;
      }

      deviceSelect.disabled = false;
      inputs.forEach((input, index) => {
        const opt = document.createElement("option");
        opt.value = input.deviceId;
        const isDefault = input.deviceId === "default";
        const isUsb = isUsbDevice(input);
        let baseLabel = input.label && input.label.trim() ? input.label : `Input ${index + 1}`;
        
        // Add USB indicator and enhance labeling
        if (isUsb) {
          baseLabel = `🔌 USB: ${baseLabel}`;
        }
        if (isDefault) {
          baseLabel = `System Default${baseLabel ? ` — ${baseLabel}` : ""}`;
        }
        
        opt.textContent = baseLabel;
        deviceSelect.appendChild(opt);
      });

      if (previous && [...deviceSelect.options].some(o => o.value === previous)) {
        deviceSelect.value = previous;
      }
      
      // Debug info
      console.log(`Found ${inputs.length} audio input devices:`, inputs.map(d => ({
        label: d.label,
        deviceId: d.deviceId,
        isUsb: isUsbDevice(d)
      })));
      
      updateDeviceCount();
    } catch (err) {
      console.error("Failed to enumerate devices", err);
    }
  }

  async function enumerateAudioOutputDevices() {
    try {
      if (!outputSelect) return;
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter(d => d.kind === "audiooutput");

      const previous = outputSelect.value;
      outputSelect.innerHTML = "";

      if (outputs.length === 0) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "No output devices found";
        outputSelect.appendChild(opt);
        outputSelect.disabled = true;
        return;
      }

      // Enhanced sorting: USB devices first, then default, then others
      outputs.sort((a, b) => {
        const aIsUsb = isUsbDevice(b);
        const bIsUsb = isUsbDevice(b);
        const aIsDefault = a.deviceId === "default";
        const bIsDefault = b.deviceId === "default";
        
        // USB devices first
        if (aIsUsb && !bIsUsb) return -1;
        if (!aIsUsb && bIsUsb) return 1;
        
        // Then default device
        if (aIsDefault && !bIsDefault) return -1;
        if (!aIsDefault && bIsDefault) return 1;
        
        // Then alphabetically
        return (a.label || "").localeCompare(b.label || "");
      });

      outputSelect.disabled = false;
      outputs.forEach((out, index) => {
        const opt = document.createElement("option");
        opt.value = out.deviceId;
        const isDefault = out.deviceId === "default";
        const isUsb = isUsbDevice(out);
        let baseLabel = out.label && out.label.trim() ? out.label : `Output ${index + 1}`;
        
        // Add USB indicator and enhance labeling
        if (isUsb) {
          baseLabel = `🔌 USB: ${baseLabel}`;
        }
        if (isDefault) {
          baseLabel = `System Default${baseLabel ? ` — ${baseLabel}` : ""}`;
        }
        
        opt.textContent = baseLabel;
        outputSelect.appendChild(opt);
      });

      if (previous && [...outputSelect.options].some(o => o.value === previous)) {
        outputSelect.value = previous;
      }
      
      // Debug info
      console.log(`Found ${outputs.length} audio output devices:`, outputs.map(d => ({
        label: d.label,
        deviceId: d.deviceId,
        isUsb: isUsbDevice(d)
      })));
      
      updateDeviceCount();
    } catch (err) {
      console.error("Failed to enumerate audio outputs", err);
    }
  }

  // Helper function to detect USB audio devices
  function isUsbDevice(device) {
    if (!device || !device.label) return false;
    
    const label = device.label.toLowerCase();
    
    // Common USB audio interface indicators
    const usbIndicators = [
      'usb', 'interface', 'audio interface', 'soundcard', 'sound card',
      'focusrite', 'scarlett', 'behringer', 'm-audio', 'native instruments',
      'presonus', 'motu', 'rme', 'apogee', 'universal audio', 'ua-',
      'scarlett', '2i2', '4i4', '8i6', '18i8', 'solo', 'duo', 'quad'
    ];
    
    return usbIndicators.some(indicator => label.includes(indicator));
  }

  // Update device count display
  function updateDeviceCount() {
    if (!deviceCountEl) return;
    
    const inputCount = deviceSelect.options.length;
    const outputCount = outputSelect ? outputSelect.options.length : 0;
    
    // Count USB devices specifically
    let usbInputCount = 0;
    let usbOutputCount = 0;
    
    for (let i = 0; i < deviceSelect.options.length; i++) {
      const opt = deviceSelect.options[i];
      if (opt.textContent.includes('🔌 USB:')) usbInputCount++;
    }
    
    if (outputSelect) {
      for (let i = 0; i < outputSelect.options.length; i++) {
        const opt = outputSelect.options[i];
        if (opt.textContent.includes('🔌 USB:')) usbOutputCount++;
      }
    }
    
    const totalInputs = inputCount;
    const totalOutputs = outputCount;
    
    deviceCountEl.textContent = `Devices: ${totalInputs} inputs (${usbInputCount} USB), ${totalOutputs} outputs (${usbOutputCount} USB)`;
    
    // Store for comparison
    lastDeviceCount = { inputs: totalInputs, outputs: totalOutputs };
  }

  async function start(deviceId) {
    if (isRunning) return;

    try {
      // Request stream from selected device
      const constraints = {
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 2 },
          sampleRate: { ideal: 48000 },
        }
      };

      mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

      // Create audio context lazily to align with sample rate
      audioContext = new (window.AudioContext || window.webkitAudioContext)({
        latencyHint: "interactive",
      });

      mediaSourceNode = audioContext.createMediaStreamSource(mediaStream);

      analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = spectrumConfig.fftSize;
      analyserNode.minDecibels = spectrumConfig.minDecibels;
      analyserNode.maxDecibels = spectrumConfig.maxDecibels;
      analyserNode.smoothingTimeConstant = spectrumConfig.smoothingTimeConstant;

      // Monitoring path: Source -> Gain -> Destination (only when enabled)
      monitorGainNode = audioContext.createGain();
      monitorGainNode.gain.value = Number(monitorGainSlider?.value || 0.6);
      monitorDestination = audioContext.destination;

      // Do NOT connect to destination by default; only analyser is connected
      mediaSourceNode.connect(analyserNode);

      // Create hidden HTMLAudioElement and MediaStreamDestination for setSinkId routing if supported
      if (typeof HTMLMediaElement.prototype.setSinkId === "function") {
        if (!htmlAudioForRouting) {
          htmlAudioForRouting = new Audio();
          htmlAudioForRouting.autoplay = true;
          htmlAudioForRouting.muted = false;
          htmlAudioForRouting.playsInline = true;
        }
        const monitorStreamDest = audioContext.createMediaStreamDestination();
        mediaSourceNode.connect(monitorGainNode);
        monitorGainNode.connect(monitorStreamDest);
        htmlAudioForRouting.srcObject = monitorStreamDest.stream;
      } else {
        // Fallback: connect gain directly to destination (no device selection)
        mediaSourceNode.connect(monitorGainNode);
        // Only connect when enabled
      }

      // Prepare buffers
      const freqBinCount = analyserNode.frequencyBinCount;
      const freqData = new Float32Array(freqBinCount);
      const timeData = new Float32Array(analyserNode.fftSize);

      // Peak hold state for spectrum bars
      const barPeaksDb = new Float32Array(spectrumConfig.barCount).fill(-Infinity);
      let lastFrameTime = performance.now();
      let peakHoldDb = -Infinity; // For VU meter peak hold

      function drawSpectrum() {
        resizeCanvasToDisplaySize(spectrumCanvas);
        const ctx = spectrumCtx;
        const { width, height } = spectrumCanvas.getBoundingClientRect();
        ctx.clearRect(0, 0, width, height);

        // Background grid
        ctx.save();
        ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--grid");
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.8;
        const dbGrid = [-60, -48, -36, -24, -12, -6, 0];
        for (const db of dbGrid) {
          const y = height * (1 - (db - spectrumConfig.minDecibels) / (spectrumConfig.maxDecibels - spectrumConfig.minDecibels));
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(width, y);
          ctx.stroke();
        }
        ctx.restore();

        // Fetch frequency data in dB
        analyserNode.getFloatFrequencyData(freqData);

        // Build gradient
        const grad = ctx.createLinearGradient(0, 0, 0, height);
        grad.addColorStop(0.0, "#fff36e");
        grad.addColorStop(0.4, "#ffd400");
        grad.addColorStop(1.0, "#ffb300");

        const barCount = spectrumConfig.barCount;
        const gap = 2;
        const barWidth = Math.max(1, Math.floor((width - (barCount - 1) * gap) / barCount));

        // Logarithmic mapping of bars to frequency bins
        const nyquist = audioContext.sampleRate / 2;
        const minHz = 20;
        const maxHz = nyquist;
        const logMin = Math.log10(minHz);
        const logMax = Math.log10(maxHz);

        const now = performance.now();
        const deltaSec = (now - lastFrameTime) / 1000;
        lastFrameTime = now;

        const peakFallDbPerSec = spectrumConfig.peakHoldFallDbPerSec;

        // subtle glow for bars
        ctx.save();
        ctx.shadowColor = "rgba(234, 179, 8, 0.45)"; // neon yellow glow
        ctx.shadowBlur = 10;
        for (let i = 0; i < barCount; i++) {
          const t0 = i / barCount;
          const t1 = (i + 1) / barCount;
          const f0 = Math.pow(10, logMin + t0 * (logMax - logMin));
          const f1 = Math.pow(10, logMin + t1 * (logMax - logMin));

          // Corresponding bin indices
          const idx0 = Math.floor(f0 / nyquist * freqBinCount);
          const idx1 = Math.min(freqBinCount - 1, Math.ceil(f1 / nyquist * freqBinCount));

          // Average dB over bins for this bar
          let sum = 0;
          let count = 0;
          for (let k = idx0; k <= idx1; k++) { sum += freqData[k]; count++; }
          const db = count > 0 ? sum / count : spectrumConfig.minDecibels;

          // Peak hold per bar
          const currentPeak = barPeaksDb[i];
          const fallen = currentPeak - peakFallDbPerSec * deltaSec;
          barPeaksDb[i] = Math.max(db, fallen);

          const magnitude = (db - spectrumConfig.minDecibels) / (spectrumConfig.maxDecibels - spectrumConfig.minDecibels);
          const peakMagnitude = (barPeaksDb[i] - spectrumConfig.minDecibels) / (spectrumConfig.maxDecibels - spectrumConfig.minDecibels);

          const x = i * (barWidth + gap);
          const h = clamp(magnitude, 0, 1) * height;
          const peakY = height * (1 - clamp(peakMagnitude, 0, 1));

          // Bar
          ctx.fillStyle = grad;
          ctx.fillRect(x, height - h, barWidth, h);

          // Peak line
          ctx.fillStyle = "#fff8c0"; // soft light-yellow peak marker
          ctx.globalAlpha = 0.95;
          ctx.fillRect(x, peakY, barWidth, 2);
          ctx.globalAlpha = 1.0;
        }
        ctx.restore();

        // Labels (left dB scale)
        ctx.save();
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--muted");
        ctx.font = "12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
        ctx.textBaseline = "middle";
        for (const db of [-60, -48, -36, -24, -12, -6, 0]) {
          const y = height * (1 - (db - spectrumConfig.minDecibels) / (spectrumConfig.maxDecibels - spectrumConfig.minDecibels));
          ctx.fillText(`${db} dB`, 8, y);
        }
        ctx.restore();
      }

      function drawVuMeter() {
        resizeCanvasToDisplaySize(vuCanvas);
        const ctx = vuCtx;
        const { width, height } = vuCanvas.getBoundingClientRect();
        ctx.clearRect(0, 0, width, height);

        analyserNode.getFloatTimeDomainData(timeData);

        // Compute RMS and peak on time domain
        let sumSquares = 0;
        let peakAbs = 0;
        for (let i = 0; i < timeData.length; i++) {
          const s = timeData[i];
          sumSquares += s * s;
          if (Math.abs(s) > peakAbs) peakAbs = Math.abs(s);
        }
        const rms = Math.sqrt(sumSquares / timeData.length);
        const rmsDb = linearToDbFS(rms);
        const peakDb = linearToDbFS(peakAbs);

        // Peak hold (fall)
        const now = performance.now();
        const deltaSec = (now - lastFrameTime) / 1000; // reuse lastFrameTime; small error is fine
        if (!isFinite(peakHoldDb)) peakHoldDb = peakDb;
        peakHoldDb = Math.max(peakDb, peakHoldDb - 18 * deltaSec);

        // Draw segmented horizontal meter
        const minDb = -60;
        const maxDb = 0;
        const padding = 10;
        const meterX = padding;
        const meterY = padding;
        const meterWidth = width - padding * 2;
        const meterHeight = height - padding * 2;
        const segments = 60;
        const segGap = 1.5;
        const segWidth = (meterWidth - (segments - 1) * segGap) / segments;

        function dbToX(db) {
          const t = clamp((db - minDb) / (maxDb - minDb), 0, 1);
          return meterX + t * meterWidth;
        }

        for (let i = 0; i < segments; i++) {
          const segDbStart = minDb + (i / segments) * (maxDb - minDb);
          const segDbEnd = minDb + ((i + 1) / segments) * (maxDb - minDb);

          // Color zones
          let color = "#3ddc97"; // good
          if (segDbEnd > -12) color = "#ffd166"; // warn
          if (segDbEnd > -3) color = "#ff6b6b"; // bad

          const x = meterX + i * (segWidth + segGap);
          const y = meterY;

          // Fill depending on current RMS
          const fillUntilX = dbToX(rmsDb);
          const segRightX = x + segWidth;

          ctx.fillStyle = color;
          ctx.globalAlpha = segRightX <= fillUntilX ? 0.95 : 0.16;
          ctx.fillRect(x, y, segWidth, meterHeight);
        }
        ctx.globalAlpha = 1.0;

        // Peak hold marker
        const peakX = dbToX(peakHoldDb);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(peakX - 1, meterY - 2, 2, meterHeight + 4);

        // Outline
        ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--border");
        ctx.lineWidth = 1;
        ctx.strokeRect(meterX - 0.5, meterY - 0.5, meterWidth + 1, meterHeight + 1);

        // Readouts
        rmsDbEl.textContent = formatDb(rmsDb);
        peakDbEl.textContent = formatDb(peakDb);
      }

      function render() {
        if (!isRunning) return;
        drawSpectrum();
        drawVuMeter();
        animationFrameHandle = requestAnimationFrame(render);
      }

      // UI Meta
      metaInfo.textContent = `Sample rate: ${audioContext.sampleRate} Hz | FFT: ${analyserNode.fftSize} | Smoothing: ${analyserNode.smoothingTimeConstant}`;
      deviceIdInUse = deviceId || "default";
      isRunning = true;
      startBtn.disabled = true;
      stopBtn.disabled = false;
      statusText.textContent = `Capturing from: ${getSelectedDeviceLabel()}`;
      
      // Ensure monitoring is enabled by default
      setMonitoringEnabled(true);
      updatePlaybackStatus();

      // Kick off
      render();
    } catch (err) {
      console.error(err);
      stop();
      statusText.textContent = `Error: ${err.message || err}`;
    }
  }

  function getSelectedDeviceLabel() {
    const opt = deviceSelect.options[deviceSelect.selectedIndex];
    return opt ? opt.textContent : "Default device";
  }

  function updatePlaybackStatus() {
    if (!playbackStatus) return;
    const isOn = monitorEnabled;
    const selectedOut = outputSelect && outputSelect.options[outputSelect.selectedIndex];
    playbackStatus.textContent = isOn ? `Playback: On${selectedOut ? ` — ${selectedOut.textContent}` : ""}` : "Playback: Off";
    if (monitorBtn) monitorBtn.textContent = isOn ? "Monitor: On" : "Monitor: Off";
  }

  async function applyOutputDeviceSelection() {
    try {
      if (!htmlAudioForRouting || typeof htmlAudioForRouting.setSinkId !== "function") return;
      const sinkId = outputSelect?.value;
      if (sinkId) {
        await htmlAudioForRouting.setSinkId(sinkId);
      }
    } catch (err) {
      console.warn("setSinkId failed", err);
    }
  }

  function setMonitoringEnabled(enabled) {
    monitorEnabled = enabled;
    if (!audioContext || !monitorGainNode) {
      updatePlaybackStatus();
      return;
    }

    // Disconnect all from gain destination first
    try {
      monitorGainNode.disconnect();
    } catch {}

    if (enabled) {
      if (htmlAudioForRouting && typeof htmlAudioForRouting.setSinkId === "function") {
        // When routing through htmlAudioForRouting, monitorGainNode is already connected to its MediaStreamDestination
        htmlAudioForRouting.muted = false;
        htmlAudioForRouting.play().catch(() => {});
      } else {
        // Fallback: connect directly to destination
        monitorGainNode.connect(monitorDestination);
      }
    } else {
      if (htmlAudioForRouting) {
        htmlAudioForRouting.pause();
        htmlAudioForRouting.muted = true;
      }
    }

    updatePlaybackStatus();
  }

  function stop() {
    try {
      isRunning = false;
      if (animationFrameHandle) cancelAnimationFrame(animationFrameHandle);
      animationFrameHandle = null;

      if (mediaStream) {
        mediaStream.getTracks().forEach(t => t.stop());
      }
      if (mediaSourceNode) mediaSourceNode.disconnect();
      if (analyserNode) analyserNode.disconnect();
      if (monitorGainNode) {
        try { monitorGainNode.disconnect(); } catch {}
      }
      if (audioContext) {
        audioContext.close();
      }
    } catch (err) {
      console.warn("Error during stop:", err);
    } finally {
      mediaStream = null;
      mediaSourceNode = null;
      analyserNode = null;
      audioContext = null;
      monitorGainNode = null;
      startBtn.disabled = false;
      stopBtn.disabled = true;
      statusText.textContent = "Idle — no input";
      metaInfo.textContent = "Sample rate: — | FFT: — | Smoothing: —";
      setMonitoringEnabled(false);
    }
  }

  // Event wiring
  refreshBtn.addEventListener("click", async () => {
    await ensurePermissions();
    await Promise.all([
      enumerateAudioInputDevices(),
      enumerateAudioOutputDevices(),
    ]);
  });

  if (usbRefreshBtn) {
    usbRefreshBtn.addEventListener("click", async () => {
      console.log("USB Refresh clicked - checking for new USB devices...");
      await ensurePermissions();
      await Promise.all([
        enumerateAudioInputDevices(),
        enumerateAudioOutputDevices(),
      ]);
      // Force a more thorough refresh for USB devices
      if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const usbInputs = devices.filter(d => d.kind === "audioinput" && isUsbDevice(d));
          const usbOutputs = devices.filter(d => d.kind === "audiooutput" && isUsbDevice(d));
          console.log(`USB Refresh found: ${usbInputs.length} USB inputs, ${usbOutputs.length} USB outputs`);
        } catch (err) {
          console.warn("USB refresh enumeration failed:", err);
        }
      }
    });
  }

  startBtn.addEventListener("click", async () => {
    await ensurePermissions();
    const chosen = deviceSelect.value || undefined;
    await start(chosen);
  });

  stopBtn.addEventListener("click", () => {
    stop();
  });

  deviceSelect.addEventListener("change", async () => {
    // If running, switch to new device on the fly
    if (isRunning) {
      const chosen = deviceSelect.value || undefined;
      stop();
      await start(chosen);
    }
  });

  if (outputSelect) {
    outputSelect.addEventListener("change", async () => {
      await applyOutputDeviceSelection();
      updatePlaybackStatus();
    });
  }

  if (monitorBtn) {
    monitorBtn.addEventListener("click", () => {
      setMonitoringEnabled(!monitorEnabled);
    });
  }

  if (monitorGainSlider) {
    monitorGainSlider.addEventListener("input", () => {
      if (monitorGainNode) {
        const v = Number(monitorGainSlider.value);
        monitorGainNode.gain.value = v;
      }
    });
  }

  if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === "function") {
    navigator.mediaDevices.addEventListener("devicechange", async () => {
      await Promise.all([
        enumerateAudioInputDevices(),
        enumerateAudioOutputDevices(),
      ]);
    });
  }

  // Initial setup
  (async function init() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      statusText.textContent = "getUserMedia not supported in this browser.";
      startBtn.disabled = true;
      return;
    }
    // Ensure permission first so labels and all inputs/outputs are available
    await ensurePermissions();
    await Promise.all([
      enumerateAudioInputDevices(),
      enumerateAudioOutputDevices(),
    ]);
    resizeCanvasToDisplaySize(spectrumCanvas);
    resizeCanvasToDisplaySize(vuCanvas);
    window.addEventListener("resize", () => {
      resizeCanvasToDisplaySize(spectrumCanvas);
      resizeCanvasToDisplaySize(vuCanvas);
    });
    updatePlaybackStatus(); // This will now show "Playback: On" by default
  })();
})(); 