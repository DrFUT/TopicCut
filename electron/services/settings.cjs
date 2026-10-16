const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

class SettingsStore {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'topiccut-settings.json');
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  write(patch) {
    const next = { ...this.read(), ...patch };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }
}

module.exports = { SettingsStore };
