// device-detector.js - Script independiente para detectar dispositivos móviles y orientación

(function() {
  // Crear el elemento de advertencia de orientación de forma dinámica
  const warningDiv = document.createElement('div');
  warningDiv.id = 'mobile-orientation-warning';
  warningDiv.innerHTML = `
    <div style="position:fixed;inset:0;background:#05060a;z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:20px;font-family:ui-monospace,Consolas,monospace;">
      <h2 style="color:#ffb347;margin-bottom:10px;font-size:24px;">⚠️ Gira tu dispositivo</h2>
      <p style="color:#8fb4d8;font-size:14px;line-height:1.5;max-width:300px;">Por favor, coloca tu teléfono o tablet en posición <b>horizontal</b> para disfrutar del simulador correctamente.</p>
    </div>
  `;
  warningDiv.style.display = 'none';
  
  // Esperar a que cargue el DOM para agregarlo
  window.addEventListener('DOMContentLoaded', () => {
    document.body.appendChild(warningDiv);
    checkOrientation();
  });

  function checkOrientation() {
    // Detectar si es un dispositivo móvil o táctil por ancho de pantalla o tipo de puntero
    const isMobile = window.innerWidth <= 900 || window.matchMedia('(pointer: coarse)').matches;
    const isPortrait = window.innerHeight > window.innerWidth;

    if (isMobile && isPortrait) {
      warningDiv.style.display = 'flex';
    } else {
      warningDiv.style.display = 'none';
    }
  }

  // Escuchar cambios de tamaño y rotación de pantalla en tiempo real
  window.addEventListener('resize', checkOrientation);
  window.addEventListener('orientationchange', checkOrientation);
})();