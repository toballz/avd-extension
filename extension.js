const vscode = require('vscode');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Store AVD-specific configurations
class AvdConfig {
  constructor() {
    this.configPath = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(), '.vscode', 'avd-config.json');
    this.configs = this.loadConfigs();
  }

  loadConfigs() {
    try {
      if (fs.existsSync(this.configPath)) {
        return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      }
    } catch (error) {
      console.error('Failed to load AVD configs:', error);
    }
    return {};
  }

  saveConfigs() {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify(this.configs, null, 2));
    } catch (error) {
      console.error('Failed to save AVD configs:', error);
    }
  }

  getConfig(avdName) {
    return this.configs[avdName] || { params: '', description: '' };
  }

  setConfig(avdName, config) {
    this.configs[avdName] = config;
    this.saveConfigs();
  }

  deleteConfig(avdName) {
    delete this.configs[avdName];
    this.saveConfigs();
  }
}

class AvdItem extends vscode.TreeItem {
  constructor(avdName, config) {
    super(avdName, vscode.TreeItemCollapsibleState.None);
    this.avdName = avdName;
    this.config = config;
    
    // Set icon
    this.iconPath = new vscode.ThemeIcon('device-mobile');
    
    // Add context value for conditional menu items
    this.contextValue = 'avd';
    
    // Set description with params if any
    if (config.params) {
      this.description = `📝 ${config.params}`;
    } else {
      this.description = 'Click play to start';
    }
    
    // Add tooltip with additional info
    this.tooltip = `${avdName}\n${config.params ? `Parameters: ${config.params}` : 'No custom parameters'}\n${config.description || ''}`;
  }
}

class AvdProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.config = new AvdConfig();
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    return element;
  }

  getChildren() {
    return new Promise((resolve) => {
      const emulatorCmd = this.getEmulatorCommand();
      
      exec(`${emulatorCmd} -list-avds`, (err, stdout, stderr) => {
        if (err) {
          console.error('Failed to list AVDs:', stderr);
          vscode.window.showErrorMessage('Failed to list AVDs. Make sure Android SDK is installed and emulator is in PATH.');
          return resolve([]);
        }

        const avds = stdout
          .split('\n')
          .map(s => s.trim())
          .filter(Boolean)
          .map(name => {
            const avdConfig = this.config.getConfig(name);
            return new AvdItem(name, avdConfig);
          });

        if (avds.length === 0) {
          const infoItem = new vscode.TreeItem('No AVDs found');
          infoItem.collapsibleState = vscode.TreeItemCollapsibleState.None;
          infoItem.description = 'Create one with AVD Manager';
          infoItem.iconPath = new vscode.ThemeIcon('info');
          resolve([infoItem]);
        } else {
          resolve(avds);
        }
      });
    });
  }

  getEmulatorCommand() {
    const config = vscode.workspace.getConfiguration('avdExplorer');
    let emulatorPath = config.get('emulatorPath');
    
    if (emulatorPath && emulatorPath !== 'emulator') {
      return emulatorPath;
    }
    
    const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
    if (androidHome) {
      const platformPath = process.platform === 'win32' ? 'emulator\\emulator.exe' : 'emulator/emulator';
      return path.join(androidHome, platformPath);
    }
    
    return 'emulator';
  }
}

class AvdManager {
  static async startAvd(avdItem) {
    const config = vscode.workspace.getConfiguration('avdExplorer');
    const emulatorCmd = new AvdProvider().getEmulatorCommand();
    
    // Build command with parameters
    let command = `${emulatorCmd} -avd ${avdItem.avdName}`;
    if (avdItem.config.params) {
      command += ` ${avdItem.config.params}`;
    }
    
    const terminal = vscode.window.createTerminal(`AVD: ${avdItem.avdName}`);
    terminal.show();
    terminal.sendText(command);
    
    vscode.window.showInformationMessage(
      `Starting ${avdItem.avdName}...`, 
      'Show Terminal', 
      'Edit Parameters'
    ).then(selection => {
      if (selection === 'Show Terminal') {
        terminal.show();
      } else if (selection === 'Edit Parameters') {
        AvdManager.editAvdParams(avdItem);
      }
    });
  }

  static async editAvdParams(avdItem) {
    const config = new AvdConfig();
    const currentConfig = config.getConfig(avdItem.avdName);
    
    // Create quick input for parameters
    const params = await vscode.window.showInputBox({
      title: `Edit Parameters for ${avdItem.avdName}`,
      prompt: 'Enter emulator parameters (e.g., -no-audio -no-window -netdelay none)',
      value: currentConfig.params,
      placeHolder: '-no-audio -no-window -gpu swiftshader_indirect',
      validateInput: (value) => {
        // Basic validation - check for dangerous commands
        if (value.includes(';') || value.includes('&') || value.includes('|')) {
          return 'Invalid characters in parameters';
        }
        return null;
      }
    });
    
    if (params !== undefined) {
      // Ask for description (optional)
      const description = await vscode.window.showInputBox({
        title: `Add Description for ${avdItem.avdName}`,
        prompt: 'Optional: Add a description for this configuration',
        value: currentConfig.description,
        placeHolder: 'e.g., Fast boot with no window for CI/CD'
      });
      
      // Save configuration
      config.setConfig(avdItem.avdName, {
        params: params.trim(),
        description: description || '',
        lastModified: new Date().toISOString()
      });
      
      vscode.window.showInformationMessage(
        `Parameters saved for ${avdItem.avdName}`,
        'Show Config'
      ).then(selection => {
        if (selection === 'Show Config') {
          AvdManager.showAvdConfig(avdItem.avdName);
        }
      });
      
      // Refresh the view
      const provider = new AvdProvider();
      provider.refresh();
    }
  }

  static async showAvdConfig(avdName) {
    const config = new AvdConfig();
    const avdConfig = config.getConfig(avdName);
    
    const configText = [
      `AVD: ${avdName}`,
      `Parameters: ${avdConfig.params || '(none)'}`,
      `Description: ${avdConfig.description || '(none)'}`,
      `Last Modified: ${avdConfig.lastModified || '(never)'}`,
      ``,
      `Full command:`,
      `emulator -avd ${avdName} ${avdConfig.params || ''}`
    ].join('\n');
    
    const doc = await vscode.workspace.openTextDocument({
      content: configText,
      language: 'text'
    });
    
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: true
    });
  }

  static async deleteAvdConfig(avdItem) {
    const config = new AvdConfig();
    const result = await vscode.window.showWarningMessage(
      `Delete parameters for ${avdItem.avdName}?`,
      { modal: true },
      'Delete',
      'Cancel'
    );
    
    if (result === 'Delete') {
      config.deleteConfig(avdItem.avdName);
      vscode.window.showInformationMessage(`Configuration deleted for ${avdItem.avdName}`);
      
      // Refresh the view
      const provider = new AvdProvider();
      provider.refresh();
    }
  }

  static async manageGlobalSettings() {
    const config = vscode.workspace.getConfiguration('avdExplorer');
    const currentPath = config.get('emulatorPath') || 'emulator';
    
    const newPath = await vscode.window.showInputBox({
      title: 'Configure Emulator Path',
      prompt: 'Enter path to emulator executable',
      value: currentPath,
      placeHolder: '/path/to/android/sdk/emulator/emulator'
    });
    
    if (newPath) {
      await config.update('emulatorPath', newPath, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Emulator path updated to: ${newPath}`);
      
      // Refresh AVD list
      const provider = new AvdProvider();
      provider.refresh();
    }
  }

  static async refreshAvds(provider) {
    await provider.refresh();
    vscode.window.showInformationMessage('AVD list refreshed');
  }

  static async openAvdManager() {
    const terminal = vscode.window.createTerminal('AVD Manager');
    terminal.show();
    terminal.sendText('avdmanager list avd');
    vscode.window.showInformationMessage('Run avdmanager to manage AVDs');
  }
}

function activate(context) {
  console.log('AVD Explorer extension is now active');
  
  const provider = new AvdProvider();
  
  // Register the tree data provider
  vscode.window.registerTreeDataProvider('avdExplorerView', provider);
  
  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('avdExplorer.refresh', () => {
      AvdManager.refreshAvds(provider);
    }),
    
    vscode.commands.registerCommand('avdExplorer.start', (avdItem) => {
      AvdManager.startAvd(avdItem);
    }),
    
    vscode.commands.registerCommand('avdExplorer.editParams', (avdItem) => {
      AvdManager.editAvdParams(avdItem);
    }),
    
    vscode.commands.registerCommand('avdExplorer.deleteConfig', (avdItem) => {
      AvdManager.deleteAvdConfig(avdItem);
    }),
    
    vscode.commands.registerCommand('avdExplorer.showConfig', (avdItem) => {
      AvdManager.showAvdConfig(avdItem.avdName);
    }),
    
    vscode.commands.registerCommand('avdExplorer.configureSdk', () => {
      AvdManager.manageGlobalSettings();
    }),
    
    vscode.commands.registerCommand('avdExplorer.openAvdManager', () => {
      AvdManager.openAvdManager();
    })
  );
  
  // Optional: Show welcome message
  setTimeout(() => {
    provider.getChildren().then(avds => {
      if (avds.length === 1 && avds[0].label === 'No AVDs found') {
        vscode.window.showInformationMessage(
          'No Android Virtual Devices found. Create one using AVD Manager.',
          'Open Documentation'
        ).then(selection => {
          if (selection === 'Open Documentation') {
            vscode.env.openExternal(vscode.Uri.parse('https://developer.android.com/studio/run/managing-avds'));
          }
        });
      }
    });
  }, 1000);
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};