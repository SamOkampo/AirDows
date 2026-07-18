class LocalAIManager {
  constructor() {
    this.enabled = true;
  }

  analyzeFile(file) {
    const name = String(file.name || 'archivo');
    const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    const type = String(file.type || '');
    const category = this.getCategory(type, extension);
    const risky = ['exe', 'msi', 'bat', 'cmd', 'ps1', 'apk', 'dmg', 'app', 'jar', 'js', 'vbs'].includes(extension);

    return {
      category,
      risky,
      label: risky ? 'Revisar archivo' : category,
      source: 'local'
    };
  }

  getCategory(type, extension) {
    if (type.startsWith('image/')) return 'Imagen';
    if (type.startsWith('video/')) return 'Video';
    if (type.startsWith('audio/')) return 'Audio';
    if (type.startsWith('text/') || ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(extension)) return 'Documento';
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(extension)) return 'Comprimido';
    if (['js', 'ts', 'json', 'html', 'css', 'py', 'java', 'c', 'cpp'].includes(extension)) return 'Codigo';
    return 'Archivo';
  }
}
