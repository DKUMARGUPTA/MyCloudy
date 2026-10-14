// Fake camera for agent-browser E2E: overrides getUserMedia with a
// canvas-captured stream showing a synthetic "document on a desk".
(() => {
  if (!window.__FAKE_CAMERA_READY__) {
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 960;
    const ctx = canvas.getContext("2d");
    // Desk background (dark, slightly textured).
    ctx.fillStyle = "#4a4a4e";
    ctx.fillRect(0, 0, 1280, 960);
    for (let i = 0; i < 500; i++) {
      ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.04})`;
      ctx.fillRect(Math.random() * 1280, Math.random() * 960, 30, 30);
    }
    // The page: rotated + sheared white sheet with text bars.
    ctx.save();
    ctx.translate(640, 480);
    ctx.rotate(-0.04);
    ctx.transform(1, 0.025, -0.02, 1.0, 0, 0);
    ctx.fillStyle = "#f2f0ea";
    ctx.fillRect(-420, -520, 840, 1040);
    ctx.fillStyle = "#222226";
    for (let row = 0; row < 30; row++) {
      const y = -465 + row * 32;
      const w = 700 - (row % 5) * 90;
      ctx.fillRect(-370, y, w, 14);
    }
    ctx.restore();
    const stream = canvas.captureStream(24);
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints) => {
      if (constraints && constraints.video) return Promise.resolve(stream);
      return orig(constraints);
    };
    navigator.mediaDevices.enumerateDevices = () =>
      Promise.resolve([
        { kind: "videoinput", deviceId: "fake0", label: "Fake Cam" },
        { kind: "videoinput", deviceId: "fake1", label: "Fake Cam 2" },
      ]);
    window.__FAKE_CAMERA_READY__ = true;
  }
})();
