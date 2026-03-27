const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Store AVD-specific configurations
class AvdConfig {
  constructor(storagePath = null) {
    // Use provided storage path or fallback to temp directory
    if (storagePath) {
      this.configPath = path.join(storagePath, 'avd-config.json');
    } else {
      // Use temp directory as fallback
      this.configPath = path.join(os.tmpdir(), 'vscode-avd-explorer', 'avd-config.json');
    }
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
    
    // Set initial display
    this.updateDisplay();
  }
  
  updateDisplay() {
    // Update description
    if (this.config && this.config.params && this.config.params.trim()) {
      this.description = `📝 ${this.config.params}`;
    } else {
      this.description = 'Click play to start';
    }
    
    // Update tooltip
    this.tooltip = `${this.avdName}\n${this.config && this.config.params ? `Parameters: ${this.config.params}` : 'No custom parameters'}\n${this.config && this.config.description || ''}`;
  }
}

class AvdProvider {
  constructor(context) {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    
    // Use global storage for better persistence across sessions
    const storagePath = context.globalStorageUri.fsPath;
    this.config = new AvdConfig(storagePath);
    this.context = context;
    this.cachedAvds = null; // Cache for AVD list
  }

  refresh() {
    // Clear cache to force reload
    this.cachedAvds = null;
    // Fire the event to refresh the tree view
    this._onDidChangeTreeData.fire();
  }

  dispose() {
    this._onDidChangeTreeData.dispose();
  }

  getTreeItem(element) {
    // Always get fresh config for the element
    if (element && element.avdName) {
      const freshConfig = this.config.getConfig(element.avdName);
      element.config = freshConfig;
      element.updateDisplay();
    }
    return element;
  }

  async getChildren() {
    // Use cached avds if available to avoid re-listing
    if (this.cachedAvds) {
      // Still need to update configs for cached items
      const updatedAvds = this.cachedAvds.map(avd => {
        const freshConfig = this.config.getConfig(avd.avdName);
        avd.config = freshConfig;
        avd.updateDisplay();
        return avd;
      });
      return updatedAvds;
    }
    
    const emulatorCmd = this.getEmulatorCommand();
    
    // Check if emulator exists before trying to list AVDs
    if (emulatorCmd !== 'emulator' && !fs.existsSync(emulatorCmd)) {
      vscode.window.showErrorMessage(`Emulator not found at: ${emulatorCmd}. Please configure the correct path in settings.`);
      const errorItem = new vscode.TreeItem('Emulator not found');
      errorItem.collapsibleState = vscode.TreeItemCollapsibleState.None;
      errorItem.description = 'Configure emulator path in settings';
      errorItem.iconPath = new vscode.ThemeIcon('error');
      errorItem.command = {
        command: 'avdExplorer.configureSdk',
        title: 'Configure Emulator Path'
      };
      return [errorItem];
    }
    
    return new Promise((resolve) => {
      exec(`${emulatorCmd} -list-avds`, (err, stdout, stderr) => {
        if (err) {
          console.error('Failed to list AVDs:', stderr);
          
          if (stderr.includes('command not found') || err.code === 'ENOENT') {
            vscode.window.showErrorMessage('Emulator command not found. Please install Android SDK and configure the emulator path in settings.');
          } else {
            vscode.window.showErrorMessage(`Failed to list AVDs: ${stderr || err.message}`);
          }
          return resolve([]);
        }

        const avdNames = stdout
          .split('\n')
          .map(s => s.trim())
          .filter(Boolean);
        
        const avds = avdNames.map(name => {
          const avdConfig = this.config.getConfig(name);
          return new AvdItem(name, avdConfig);
        });

        // Cache the avds
        this.cachedAvds = avds;

        if (avds.length === 0) {
          const infoItem = new vscode.TreeItem('No AVDs found');
          infoItem.collapsibleState = vscode.TreeItemCollapsibleState.None;
          infoItem.description = 'Create one with AVD Manager';
          infoItem.iconPath = new vscode.ThemeIcon('info');
          infoItem.command = {
            command: 'avdExplorer.openAvdManager',
            title: 'Open AVD Manager'
          };
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
    
    // Check common Android SDK locations
    const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
    if (androidHome) {
      const emulatorExe = process.platform === 'win32' ? 'emulator.exe' : 'emulator';
      const emulatorPathNew = path.join(androidHome, 'emulator', emulatorExe);
      
      // Check if emulator exists in new location
      if (fs.existsSync(emulatorPathNew)) {
        return emulatorPathNew;
      }
      
      // Fallback to legacy location
      const emulatorPathLegacy = path.join(androidHome, 'tools', emulatorExe);
      if (fs.existsSync(emulatorPathLegacy)) {
        return emulatorPathLegacy;
      }
      
      // If neither exists, return the new path anyway (user will get error)
      return emulatorPathNew;
    }
    
    return 'emulator';
  }

  // Add method to get config instance
  getConfig() {
    return this.config;
  }
  
  // Force a complete reload of AVDs
  async forceReload() {
    this.cachedAvds = null;
    this.refresh();
  }
}

class AvdManager {
  static async startAvd(avdItem, provider) {
    const emulatorCmd = provider.getEmulatorCommand();
    
    // Validate AVD name to prevent command injection
    if (!/^[a-zA-Z0-9_\-]+$/.test(avdItem.avdName)) {
      vscode.window.showErrorMessage('Invalid AVD name');
      return;
    }
    
    // IMPORTANT: Get the latest config to ensure we have the most recent parameters
    const configInstance = provider.getConfig();
    const latestConfig = configInstance.getConfig(avdItem.avdName);
    
    // Debug: Log what we're about to run
    console.log('Starting AVD:', avdItem.avdName);
    console.log('Latest config params:', latestConfig.params);
    
    // Check if terminal already exists
    const terminalName = `AVD: ${avdItem.avdName}`;
    const existingTerminal = vscode.window.terminals.find(t => t.name === terminalName);
    
    if (existingTerminal) {
      const result = await vscode.window.showWarningMessage(
        `${avdItem.avdName} is already running in a terminal`,
        'Show Terminal',
        'Start New'
      );
      
      if (result === 'Show Terminal') {
        existingTerminal.show();
        return;
      }
      
      if (result === 'Start New') {
        existingTerminal.dispose();
      } else {
        return;
      }
    }
    
    // Build command with parameters
    let command = `&"${emulatorCmd}" -avd ${avdItem.avdName}`;
    
    if (latestConfig.params && latestConfig.params.trim()) {
      command += ` ${latestConfig.params.trim()}`;
      console.log('Full command with params:', command);
    } else {
      console.log('No params found, running without parameters');
    }
    
    const terminal = vscode.window.createTerminal(terminalName);
    terminal.show();
    terminal.sendText(command);
    
    vscode.window.showInformationMessage(
      `Starting ${avdItem.avdName}${latestConfig.params ? ' with parameters' : '...'}`, 
      'Show Terminal', 
      'Edit Parameters'
    ).then(selection => {
      if (selection === 'Show Terminal') {
        terminal.show();
      } else if (selection === 'Edit Parameters') {
        AvdManager.editAvdParams(avdItem, configInstance, provider);
      }
    });
  }

  static async editAvdParams(avdItem, configInstance, provider) {
    const currentConfig = configInstance.getConfig(avdItem.avdName);
    
    // Show current parameters in input box
    const params = await vscode.window.showInputBox({
      title: `Edit Parameters for ${avdItem.avdName}`,
      prompt: 'Enter emulator parameters (e.g., -no-audio -no-window -netdelay none)',
      value: currentConfig.params,
      placeHolder: '-no-audio -no-window -gpu swiftshader_indirect',
      validateInput: (value) => {
        if (value && (value.includes(';') || value.includes('&') || value.includes('|') || value.includes('`'))) {
          return 'Invalid characters in parameters';
        }
        return null;
      }
    });
    
    if (params !== undefined) {
      // Ask for description
      const description = await vscode.window.showInputBox({
        title: `Add Description for ${avdItem.avdName}`,
        prompt: 'Optional: Add a description for this configuration',
        value: currentConfig.description,
        placeHolder: 'e.g., Fast boot with no window for CI/CD'
      });
      
      // Save configuration
      const newConfig = {
        params: params ? params.trim() : '',
        description: description || '',
        lastModified: new Date().toISOString()
      };
      
      configInstance.setConfig(avdItem.avdName, newConfig);
      
      // Update the avdItem's config directly
      avdItem.config = newConfig;
      avdItem.updateDisplay();
      
      // Show success message with preview
      const previewMessage = params ? `Parameters saved: ${params}` : 'Parameters cleared';
      vscode.window.showInformationMessage(
        previewMessage,
        'Show Config',
        'Refresh View'
      ).then(async selection => {
        if (selection === 'Show Config') {
          AvdManager.showAvdConfig(avdItem.avdName, configInstance);
        } else if (selection === 'Refresh View') {
          // Force a complete refresh
          await provider.forceReload();
        }
      });
      
      // CRITICAL: Force refresh the tree view to show updated parameters
      provider.refresh();
      
      // Also manually update the tree view if possible
      try {
        await vscode.commands.executeCommand('workbench.actions.treeView.avdExplorerView.refresh');
      } catch (e) {
        // Ignore if command doesn't exist
      }
    }
  }

  static async showAvdConfig(avdName, configInstance) {
    const avdConfig = configInstance.getConfig(avdName);
    
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

  static async deleteAvdConfig(avdItem, configInstance, provider) {
    const result = await vscode.window.showWarningMessage(
      `Delete parameters for ${avdItem.avdName}?`,
      { modal: true },
      'Delete',
      'Cancel'
    );
    
    if (result === 'Delete') {
      configInstance.deleteConfig(avdItem.avdName);
      
      // Update the avdItem's config
      avdItem.config = { params: '', description: '' };
      avdItem.updateDisplay();
      
      vscode.window.showInformationMessage(`Configuration deleted for ${avdItem.avdName}`);
      
      // Force refresh
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
      placeHolder: '/path/to/android/sdk/emulator/emulator',
      validateInput: (value) => {
        if (value && value !== 'emulator' && !fs.existsSync(value)) {
          return 'File does not exist. Please provide a valid path.';
        }
        return null;
      }
    });
    
    if (newPath !== undefined) {
      await config.update('emulatorPath', newPath || undefined, vscode.ConfigurationTarget.Global);
      if (newPath) {
        vscode.window.showInformationMessage(`Emulator path updated to: ${newPath}`);
      } else {
        vscode.window.showInformationMessage('Reset to default emulator command');
      }
      
      // Refresh AVD list after path change
      vscode.commands.executeCommand('avdExplorer.refresh');
    }
  }

  static async refreshAvds(provider) {
    await provider.forceReload();
    vscode.window.showInformationMessage('AVD list refreshed');
  }

  static async openAvdManager() {
    const terminal = vscode.window.createTerminal('AVD Manager');
    terminal.show();
    terminal.sendText('echo "To manage AVDs, use: avdmanager list avd"');
    terminal.sendText('echo "Or open Android Studio > AVD Manager"');
    vscode.window.showInformationMessage('AVD Manager opened in terminal. Use avdmanager commands to manage AVDs.');
  }
  
  static async stopAvd(avdItem) {
    const terminalName = `AVD: ${avdItem.avdName}`;
    const existingTerminal = vscode.window.terminals.find(t => t.name === terminalName);
    
    if (existingTerminal) {
      const result = await vscode.window.showWarningMessage(
        `Stop ${avdItem.avdName}?`,
        'Stop',
        'Cancel'
      );
      
      if (result === 'Stop') {
        existingTerminal.dispose();
        vscode.window.showInformationMessage(`${avdItem.avdName} stopped`);
      }
    } else {
      vscode.window.showInformationMessage(`${avdItem.avdName} is not running`);
    }
  }
}

function activate(context) {
  console.log('AVD Explorer extension is now active');
  
  const provider = new AvdProvider(context);
  
  // Register the tree data provider
  const treeView = vscode.window.createTreeView('avdExplorerView', {
    treeDataProvider: provider,
    showCollapseAll: true
  });
  
  // Register commands
  context.subscriptions.push(
    treeView,
    provider,
    
    vscode.commands.registerCommand('avdExplorer.refresh', () => {
      AvdManager.refreshAvds(provider);
    }),
    
    vscode.commands.registerCommand('avdExplorer.start', (avdItem) => {
      AvdManager.startAvd(avdItem, provider);
    }),
    
    vscode.commands.registerCommand('avdExplorer.editParams', (avdItem) => {
      AvdManager.editAvdParams(avdItem, provider.getConfig(), provider);
    }),
    
    vscode.commands.registerCommand('avdExplorer.deleteConfig', (avdItem) => {
      AvdManager.deleteAvdConfig(avdItem, provider.getConfig(), provider);
    }),
    
    vscode.commands.registerCommand('avdExplorer.showConfig', (avdItem) => {
      AvdManager.showAvdConfig(avdItem.avdName, provider.getConfig());
    }),
    
    vscode.commands.registerCommand('avdExplorer.configureSdk', () => {
      AvdManager.manageGlobalSettings();
    }),
    
    vscode.commands.registerCommand('avdExplorer.openAvdManager', () => {
      AvdManager.openAvdManager();
    }),
    
    vscode.commands.registerCommand('avdExplorer.stop', (avdItem) => {
      AvdManager.stopAvd(avdItem);
    })
  );
  
  // Optional: Show welcome message after extension activation
  setTimeout(async () => {
    try {
      const avds = await provider.getChildren();
      if (avds.length === 1 && avds[0].label === 'No AVDs found') {
        const selection = await vscode.window.showInformationMessage(
          'No Android Virtual Devices found. Create one using AVD Manager.',
          'Open Documentation',
          'Configure Emulator Path'
        );
        
        if (selection === 'Open Documentation') {
          vscode.env.openExternal(vscode.Uri.parse('https://developer.android.com/studio/run/managing-avds'));
        } else if (selection === 'Configure Emulator Path') {
          AvdManager.manageGlobalSettings();
        }
      }
    } catch (error) {
      console.error('Error checking AVDs:', error);
    }
  }, 1000);
}

function deactivate() {
  console.log('AVD Explorer extension is deactivated');
}

module.exports = {
  activate,
  deactivate
};