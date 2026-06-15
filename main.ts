import {
  App,
  FileSystemAdapter,
  MarkdownPostProcessorContext,
  MarkdownRenderer,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  normalizePath,
} from "obsidian";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FontEntry {
  /** CSS font-family name the user assigns (editable in settings). */
  name: string;
  /** Filename under the plugin's fonts/ directory. */
  filename: string;
}

interface FontAlias {
  /** Code-block language string (e.g. "handwriting", "typewriter"). */
  id: string;
  /** Matches a FontEntry.name. */
  fontName: string;
  size: string;
  weight: string;
  style: string;
  color: string;
  lineHeight: string;
  align: string;
  letterSpacing: string;
}

interface CustomFontsSettings {
  fonts: FontEntry[];
  aliases: FontAlias[];
}

const DEFAULT_SETTINGS: CustomFontsSettings = {
  fonts: [],
  aliases: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FONT_FORMATS: Record<string, string> = {
  woff2: "woff2",
  woff: "woff",
  ttf: "truetype",
  otf: "opentype",
};

function fontFormat(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return FONT_FORMATS[ext] ?? "truetype";
}

/**
 * Parse the top of a code-block source into key: value config pairs and
 * remaining content. The header ends at the first blank line.
 */
function parseBlock(source: string): {
  config: Record<string, string>;
  content: string;
} {
  const lines = source.split("\n");
  const config: Record<string, string> = {};
  let i = 0;

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      i++; // skip the blank separator
      break;
    }
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (!m) {
      // Not a key:value line — treat everything from here as content
      break;
    }
    config[m[1]] = m[2].trim();
  }

  return { config, content: lines.slice(i).join("\n") };
}

function applyStyles(el: HTMLElement, cfg: Record<string, string>) {
  if (cfg.family) el.style.fontFamily = `"${cfg.family}", sans-serif`;
  if (cfg.size) el.style.fontSize = cfg.size;
  if (cfg.color) el.style.color = cfg.color;
  if (cfg.weight) el.style.fontWeight = cfg.weight;
  if (cfg.style) el.style.fontStyle = cfg.style;
  const lh = cfg["line-height"] ?? cfg.lineHeight;
  if (lh) el.style.lineHeight = lh;
  if (cfg.align) el.style.textAlign = cfg.align as CanvasTextAlign;
  const ls = cfg["letter-spacing"] ?? cfg.letterSpacing;
  if (ls) el.style.letterSpacing = ls;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default class CustomFontsPlugin extends Plugin {
  settings: CustomFontsSettings;
  private styleEl: HTMLStyleElement;
  /** Tracks which alias IDs have had a processor registered this session. */
  private registeredAliases = new Set<string>();

  async onload() {
    await this.loadSettings();
    await this.ensureFontsDir();

    this.styleEl = document.createElement("style");
    this.styleEl.id = "custom-fonts-plugin-faces";
    document.head.appendChild(this.styleEl);
    this.refreshFontFaces();

    // Generic font block: ```font
    this.registerMarkdownCodeBlockProcessor(
      "font",
      async (source, el, ctx) => {
        await this.renderBlock(source, el, ctx, {});
      }
    );

    // Register processors for all saved aliases on startup
    for (const alias of this.settings.aliases) {
      this.registerAliasProcessor(alias);
    }

    this.addSettingTab(new CustomFontsSettingTab(this.app, this));
  }

  onunload() {
    this.styleEl?.remove();
  }

  // -------------------------------------------------------------------------
  // Font-face management
  // -------------------------------------------------------------------------

  get fontsDir(): string {
    return normalizePath(`${this.manifest.dir}/fonts`);
  }

  private async ensureFontsDir() {
    if (!(await this.app.vault.adapter.exists(this.fontsDir))) {
      await this.app.vault.adapter.mkdir(this.fontsDir);
    }
  }

  private getFontUrl(filename: string): string {
    const adapter = this.app.vault.adapter as FileSystemAdapter;
    return adapter.getResourcePath(
      normalizePath(`${this.fontsDir}/${filename}`)
    );
  }

  /** Rebuild the @font-face stylesheet from current settings. */
  refreshFontFaces() {
    this.styleEl.textContent = this.settings.fonts
      .map(
        (f) =>
          `@font-face { font-family: "${f.name}"; src: url("${this.getFontUrl(
            f.filename
          )}") format("${fontFormat(f.filename)}"); }`
      )
      .join("\n");
  }

  // -------------------------------------------------------------------------
  // Code-block rendering
  // -------------------------------------------------------------------------

  registerAliasProcessor(alias: FontAlias) {
    if (this.registeredAliases.has(alias.id)) return;
    this.registeredAliases.add(alias.id);

    this.registerMarkdownCodeBlockProcessor(
      alias.id,
      async (source, el, ctx) => {
        // Re-read from live settings so edits take effect without reload
        const current = this.settings.aliases.find((a) => a.id === alias.id);
        if (!current) {
          el.createEl("p", {
            text: `Custom font alias "${alias.id}" was removed. Reload the plugin to deregister this block type.`,
            cls: "custom-font-error",
          });
          return;
        }
        const defaults: Record<string, string> = {};
        if (current.fontName) defaults.family = current.fontName;
        if (current.size) defaults.size = current.size;
        if (current.weight) defaults.weight = current.weight;
        if (current.style) defaults.style = current.style;
        if (current.color) defaults.color = current.color;
        if (current.lineHeight) defaults["line-height"] = current.lineHeight;
        if (current.align) defaults.align = current.align;
        if (current.letterSpacing)
          defaults["letter-spacing"] = current.letterSpacing;

        await this.renderBlock(source, el, ctx, defaults);
      }
    );
  }

  private async renderBlock(
    source: string,
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext,
    defaults: Record<string, string>
  ) {
    const { config, content } = parseBlock(source);
    // Per-block config overrides alias/default config
    const merged: Record<string, string> = { ...defaults, ...config };

    const wrapper = el.createDiv({ cls: "custom-font-block" });
    applyStyles(wrapper, merged);

    if (!merged.family) {
      wrapper.createEl("p", {
        text: '⚠ No font specified. Add "family: Your Font Name" at the top of the block.',
        cls: "custom-font-error",
      });
    }

    const text = content.trim();
    if (text) {
      await MarkdownRenderer.render(
        this.app,
        text,
        wrapper,
        ctx.sourcePath,
        this
      );
    }
  }

  // -------------------------------------------------------------------------
  // Font file management
  // -------------------------------------------------------------------------

  /** Copy an uploaded File into the plugin's fonts/ dir and register it. */
  async installFont(file: File): Promise<string> {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!["ttf", "otf", "woff", "woff2"].includes(ext)) {
      throw new Error("Unsupported format. Use TTF, OTF, WOFF, or WOFF2.");
    }

    const filename = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const buf = await file.arrayBuffer();
    await this.app.vault.adapter.writeBinary(
      normalizePath(`${this.fontsDir}/${filename}`),
      buf
    );

    // Derive a readable name from the filename
    const raw = filename.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
    const name = raw.charAt(0).toUpperCase() + raw.slice(1);

    if (!this.settings.fonts.find((f) => f.filename === filename)) {
      this.settings.fonts.push({ name, filename });
      await this.saveSettings();
    }
    return name;
  }

  async removeFont(filename: string) {
    try {
      await this.app.vault.adapter.remove(
        normalizePath(`${this.fontsDir}/${filename}`)
      );
    } catch {
      // already gone — ignore
    }
    this.settings.fonts = this.settings.fonts.filter(
      (f) => f.filename !== filename
    );
    await this.saveSettings();
  }

  // -------------------------------------------------------------------------
  // Alias management
  // -------------------------------------------------------------------------

  async addAlias(alias: FontAlias) {
    this.settings.aliases.push(alias);
    await this.saveSettings();
    this.registerAliasProcessor(alias);
  }

  async removeAlias(id: string) {
    this.settings.aliases = this.settings.aliases.filter((a) => a.id !== id);
    await this.saveSettings();
    // The processor stays registered until plugin reload, but it shows an error
  }

  // -------------------------------------------------------------------------
  // Settings persistence
  // -------------------------------------------------------------------------

  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    if (!this.settings.aliases) this.settings.aliases = [];
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshFontFaces();
  }
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

class CustomFontsSettingTab extends PluginSettingTab {
  plugin: CustomFontsPlugin;

  constructor(app: App, plugin: CustomFontsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderFontsSection(containerEl);
    this.renderAliasesSection(containerEl);
    this.renderUsageSection(containerEl);
  }

  // ---- Fonts ---------------------------------------------------------------

  private renderFontsSection(root: HTMLElement) {
    root.createEl("h2", { text: "Installed Fonts" });

    new Setting(root)
      .setName("Add font file")
      .setDesc("Upload a TTF, OTF, WOFF, or WOFF2 file. The font will be stored inside the plugin folder.")
      .addButton((btn) =>
        btn
          .setButtonText("Choose file…")
          .setCta()
          .onClick(() => this.pickFontFile())
      );

    if (this.plugin.settings.fonts.length === 0) {
      root.createEl("p", {
        text: "No fonts installed yet.",
        cls: "setting-item-description",
      });
      return;
    }

    root.createEl("p", {
      text: "Edit the name to change the font-family string used in code blocks.",
      cls: "setting-item-description",
    });

    for (const font of this.plugin.settings.fonts) {
      const s = new Setting(root)
        .setName(font.filename)
        .addText((text) =>
          text
            .setValue(font.name)
            .setPlaceholder("Font family name")
            .onChange(async (v) => {
              font.name = v;
              await this.plugin.saveSettings();
            })
        )
        .addExtraButton((btn) =>
          btn
            .setIcon("trash")
            .setTooltip("Remove font")
            .onClick(async () => {
              await this.plugin.removeFont(font.filename);
              new Notice("Font removed.");
              this.display();
            })
        );

      // Live preview
      const preview = s.descEl.createDiv({ cls: "custom-fonts-preview-text" });
      preview.style.fontFamily = `"${font.name}", sans-serif`;
      preview.textContent = "The quick brown fox jumps over the lazy dog.";
    }
  }

  private pickFontFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".ttf,.otf,.woff,.woff2";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const name = await this.plugin.installFont(file);
        new Notice(`Font "${name}" installed. Use family: ${name} in font blocks.`);
        this.display();
      } catch (e: any) {
        new Notice(`Error installing font: ${e.message}`);
      }
    });
    input.click();
  }

  // ---- Aliases -------------------------------------------------------------

  private renderAliasesSection(root: HTMLElement) {
    root.createEl("h2", { text: "Named Block Aliases" });
    root.createEl("p", {
      text: 'Aliases let you write ```alias-name blocks that automatically apply a specific font and style — no config header needed.',
      cls: "setting-item-description",
    });

    for (const alias of this.plugin.settings.aliases) {
      const desc = [
        `font: ${alias.fontName}`,
        alias.size && `size: ${alias.size}`,
        alias.weight && `weight: ${alias.weight}`,
        alias.color && `color: ${alias.color}`,
      ]
        .filter(Boolean)
        .join(", ");

      new Setting(root)
        .setName(`\`\`\`${alias.id}`)
        .setDesc(desc)
        .addExtraButton((btn) =>
          btn
            .setIcon("trash")
            .setTooltip("Remove alias")
            .onClick(async () => {
              await this.plugin.removeAlias(alias.id);
              new Notice(
                `Alias "${alias.id}" removed. Reload the plugin to fully deregister the block type.`
              );
              this.display();
            })
        );
    }

    // New alias form
    root.createEl("p", {
      cls: "custom-fonts-section-heading",
      text: "Create alias",
    });

    let id = "";
    let fontName = this.plugin.settings.fonts[0]?.name ?? "";
    let size = "";
    let weight = "";
    let style = "";
    let color = "";
    let lineHeight = "";
    let align = "";
    let letterSpacing = "";

    new Setting(root)
      .setName("Block name")
      .setDesc("Letters, numbers, and hyphens only — e.g. handwriting, typewriter")
      .addText((t) => t.setPlaceholder("handwriting").onChange((v) => { id = v; }));

    new Setting(root)
      .setName("Font family")
      .setDesc("Must match the name of an installed font above")
      .addText((t) =>
        t.setValue(fontName).setPlaceholder("Font name").onChange((v) => { fontName = v; })
      );

    new Setting(root).setName("Size").addText((t) =>
      t.setPlaceholder("e.g. 20px").onChange((v) => { size = v; })
    );

    new Setting(root).setName("Weight").addText((t) =>
      t.setPlaceholder("e.g. bold or 700").onChange((v) => { weight = v; })
    );

    new Setting(root).setName("Style").addText((t) =>
      t.setPlaceholder("e.g. italic").onChange((v) => { style = v; })
    );

    new Setting(root).setName("Color").addText((t) =>
      t.setPlaceholder("e.g. #333 or rebeccapurple").onChange((v) => { color = v; })
    );

    new Setting(root).setName("Line height").addText((t) =>
      t.setPlaceholder("e.g. 1.6").onChange((v) => { lineHeight = v; })
    );

    new Setting(root).setName("Text align").addText((t) =>
      t.setPlaceholder("e.g. center").onChange((v) => { align = v; })
    );

    new Setting(root).setName("Letter spacing").addText((t) =>
      t.setPlaceholder("e.g. 0.05em").onChange((v) => { letterSpacing = v; })
    );

    new Setting(root).addButton((btn) =>
      btn
        .setButtonText("Create alias")
        .setCta()
        .onClick(async () => {
          const safeId = id.trim().replace(/[^a-zA-Z0-9-]/g, "");
          if (!safeId) {
            new Notice("Enter a block name.");
            return;
          }
          if (!fontName.trim()) {
            new Notice("Enter a font name.");
            return;
          }
          if (
            safeId === "font" ||
            this.plugin.settings.aliases.find((a) => a.id === safeId)
          ) {
            new Notice(`"${safeId}" is already taken.`);
            return;
          }
          await this.plugin.addAlias({
            id: safeId,
            fontName: fontName.trim(),
            size,
            weight,
            style,
            color,
            lineHeight,
            align,
            letterSpacing,
          });
          new Notice(`Alias "${safeId}" created.`);
          this.display();
        })
    );
  }

  // ---- Usage docs ----------------------------------------------------------

  private renderUsageSection(root: HTMLElement) {
    root.createEl("h2", { text: "Usage" });

    root.createEl("p", {
      text: "Use a font block anywhere in your notes. The header (key: value pairs) is optional — leave it out if the block has no config.",
    });

    root.createEl("pre").createEl("code", {
      text: "```font\nfamily: My Font Name\nsize: 22px\nweight: bold\ncolor: #2d5a8e\n\nYour text here.\nMarkdown **bold** and _italic_ also work.\n```",
    });

    root.createEl("p", { text: "Supported header properties:" });
    const ul = root.createEl("ul");
    [
      "family — CSS font-family (required unless using an alias)",
      "size — e.g. 18px, 1.4em",
      "weight — e.g. bold, 700",
      "style — e.g. italic",
      "color — any CSS color",
      "line-height — e.g. 1.6",
      "align — e.g. center, right",
      "letter-spacing — e.g. 0.05em",
    ].forEach((line) => ul.createEl("li", { text: line }));

    if (this.plugin.settings.aliases.length > 0) {
      root.createEl("p", {
        text: "With a named alias you can skip the header entirely:",
      });
      root.createEl("pre").createEl("code", {
        text: `\`\`\`${this.plugin.settings.aliases[0].id}\nYour text here — font and style are preset.\n\`\`\``,
      });
      root.createEl("p", {
        text: "You can still add header lines to override individual alias properties on a per-block basis.",
        cls: "setting-item-description",
      });
    }
  }
}
