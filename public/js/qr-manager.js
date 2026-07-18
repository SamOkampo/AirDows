const QRManager = {
  draw(container, value, size = 240) {
    if (!container || typeof qrcode !== 'function') {
      throw new Error('QR generator is not available.');
    }

    const qr = qrcode(0, 'H');
    qr.addData(String(value));
    qr.make();

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: false });
    const moduleCount = qr.getModuleCount();
    const quietZone = 3;
    const cellSize = Math.max(1, Math.floor(size / (moduleCount + quietZone * 2)));
    const pixelSize = cellSize * (moduleCount + quietZone * 2);

    canvas.width = pixelSize;
    canvas.height = pixelSize;
    canvas.style.display = 'block';
    canvas.style.margin = '0 auto';
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    canvas.setAttribute('aria-label', 'QR de conexión AirDows');

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, pixelSize, pixelSize);
    context.fillStyle = '#070A12';

    for (let row = 0; row < moduleCount; row += 1) {
      for (let col = 0; col < moduleCount; col += 1) {
        if (qr.isDark(row, col)) {
          context.fillRect(
            (col + quietZone) * cellSize,
            (row + quietZone) * cellSize,
            cellSize,
            cellSize
          );
        }
      }
    }

    container.replaceChildren(canvas);
    return canvas;
  }
};
