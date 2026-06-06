window.UIMisc = (() => {
    function buildEmojiModal(remainingSlots) {
        const root = document.createElement('div');
        root.style.display = 'flex';
        root.style.flexDirection = 'column';
        root.style.gap = '24px';

        const tip = document.createElement('div');
        tip.style.padding = '16px 20px';
        tip.style.background = 'rgba(0, 122, 255, 0.1)';
        tip.style.borderRadius = '12px';
        tip.style.border = '1px solid rgba(0, 122, 255, 0.3)';
        const tipText = document.createElement('div');
        tipText.style.fontSize = 'var(--font-body)';
        tipText.style.fontFamily = 'var(--font-family-base)';
        tipText.style.color = 'var(--accent-blue)';
        tipText.style.textAlign = 'center';
        tipText.textContent = `💡 剩余空间: ${remainingSlots} 个表情位`;
        tip.appendChild(tipText);
        root.appendChild(tip);

        const textSection = document.createElement('div');
        textSection.className = 'emoji-input-section';
        const textLabel = document.createElement('label');
        textLabel.style.display = 'block';
        textLabel.style.marginBottom = '12px';
        textLabel.style.fontWeight = '600';
        textLabel.style.fontSize = 'var(--font-body-lg)';
        textLabel.style.fontFamily = 'var(--font-family-base)';
        textLabel.textContent = '📝 文本Emoji';
        textSection.appendChild(textLabel);
        const textInput = document.createElement('input');
        textInput.type = 'text';
        textInput.className = 'input-base';
        textInput.id = 'newEmoji';
        textInput.placeholder = '输入或粘贴emoji';
        textInput.style.fontSize = 'var(--font-display-sm)';
        textInput.style.fontFamily = 'var(--font-family-emoji)';
        textInput.style.textAlign = 'center';
        textInput.style.padding = '20px';
        textInput.style.borderRadius = '12px';
        textInput.style.border = '2px solid rgba(255,255,255,0.15)';
        textInput.style.background = 'rgba(60,60,65,0.6)';
        textInput.style.height = 'auto';
        textSection.appendChild(textInput);
        root.appendChild(textSection);

        const divider = document.createElement('div');
        divider.style.textAlign = 'center';
        divider.style.color = 'rgba(255,255,255,0.4)';
        divider.style.fontSize = 'var(--font-body)';
        divider.style.fontFamily = 'var(--font-family-base)';
        divider.style.position = 'relative';
        divider.style.margin = '8px 0';
        const dividerText = document.createElement('span');
        dividerText.style.background = 'rgba(40, 40, 45, 0.9)';
        dividerText.style.padding = '0 16px';
        dividerText.style.position = 'relative';
        dividerText.style.zIndex = '1';
        dividerText.textContent = '或';
        divider.appendChild(dividerText);
        const dividerLine = document.createElement('div');
        dividerLine.style.position = 'absolute';
        dividerLine.style.top = '50%';
        dividerLine.style.left = '0';
        dividerLine.style.right = '0';
        dividerLine.style.height = '1px';
        dividerLine.style.background = 'rgba(255,255,255,0.1)';
        divider.appendChild(dividerLine);
        root.appendChild(divider);

        const imageSection = document.createElement('div');
        imageSection.className = 'emoji-input-section';
        const imageLabel = document.createElement('label');
        imageLabel.style.display = 'block';
        imageLabel.style.marginBottom = '12px';
        imageLabel.style.fontWeight = '600';
        imageLabel.style.fontSize = 'var(--font-body-lg)';
        imageLabel.style.fontFamily = 'var(--font-family-base)';
        imageLabel.textContent = '🖼️ 图片表情包';
        imageSection.appendChild(imageLabel);
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.id = 'emojiImage';
        fileInput.accept = 'image/*';
        fileInput.multiple = true;
        fileInput.style.display = 'none';
        imageSection.appendChild(fileInput);
        const fileBtn = document.createElement('button');
        fileBtn.type = 'button';
        fileBtn.className = 'btn-base btn-md btn-outline';
        fileBtn.style.width = '100%';
        fileBtn.style.height = 'auto';
        fileBtn.style.padding = '24px';
        fileBtn.style.border = '2px dashed rgba(0, 122, 255, 0.5)';
        fileBtn.style.background = 'rgba(0, 122, 255, 0.05)';
        fileBtn.style.color = 'var(--accent-blue)';
        fileBtn.style.fontSize = 'var(--font-body)';
        fileBtn.style.fontFamily = 'var(--font-family-base)';
        fileBtn.style.fontWeight = '600';
        fileBtn.style.display = 'flex';
        fileBtn.style.alignItems = 'center';
        fileBtn.style.justifyContent = 'center';
        fileBtn.style.gap = '10px';
        fileBtn.innerHTML = '<span style="font-size: var(--font-icon-sm);">📤</span><span>点击选择图片 (支持批量上传)</span>';
        fileBtn.addEventListener('click', () => fileInput.click());
        imageSection.appendChild(fileBtn);
        const preview = document.createElement('div');
        preview.id = 'imagePreview';
        preview.style.marginTop = '16px';
        preview.style.display = 'grid';
        preview.style.gridTemplateColumns = 'repeat(auto-fill, minmax(80px, 1fr))';
        preview.style.gap = '12px';
        preview.style.maxHeight = '200px';
        preview.style.overflowY = 'auto';
        preview.style.padding = '4px';
        imageSection.appendChild(preview);
        const hint = document.createElement('div');
        hint.id = 'uploadHint';
        hint.style.marginTop = '10px';
        hint.style.fontSize = 'var(--font-body)';
        hint.style.color = 'rgba(255,255,255,0.5)';
        hint.style.textAlign = 'center';
        hint.style.fontFamily = 'var(--font-family-base)';
        hint.textContent = '支持 JPG、PNG、GIF 格式';
        imageSection.appendChild(hint);
        root.appendChild(imageSection);

        return root;
    }

    function readEmojiFormValues() {
        return {
            emojiText: (document.getElementById('newEmoji')?.value || '').trim(),
            imageFiles: document.getElementById('emojiImage')?.files || [],
            preview: document.getElementById('imagePreview'),
            modalBody: document.getElementById('modalBody'),
        };
    }

    function renderTodoList(listEl, todoItems) {
        if (!listEl) return;
        if (!todoItems || todoItems.length === 0) {
            listEl.innerHTML = `
                <div class="empty-state" style="padding: 32px 16px; text-align: center; color: var(--text-secondary);">
                    <div style="font-size: 40px; margin-bottom: 12px;">🗒️</div>
                    <div>还没有待办事项</div>
                </div>
            `;
            return;
        }

        listEl.innerHTML = todoItems.map((todo) => `
            <div class="todo-item ${todo.completed ? 'completed' : ''}" data-todo-id="${todo.id}">
                <div class="todo-checkbox" data-todo-action="toggle">${todo.completed ? '✓' : ''}</div>
                <div class="todo-content" data-todo-action="toggle">
                    <div class="todo-text">${window.UIComponents.escapeHtml(todo.content)}</div>
                    <div class="todo-meta">${window.UIComponents.escapeHtml(todo.createdAt || '')}</div>
                </div>
                <div class="todo-delete" data-todo-action="delete">×</div>
            </div>
        `).join('');
    }

    function renderEmojiGrid(grid, emojis, handlers) {
        const { onAdd, onDelete, onClick } = handlers;
        if (!grid) return;
        grid.innerHTML = '';
        emojis.forEach((emojiItem, index) => {
            const btn = document.createElement('button');
            btn.className = 'btn-base btn-glass emoji-button';
            if (emojiItem.type === 'image') {
                const img = document.createElement('img');
                img.src = emojiItem.content;
                img.style.width = '100%';
                img.style.height = '100%';
                img.style.objectFit = 'contain';
                btn.appendChild(img);
            } else {
                btn.textContent = emojiItem.content;
            }

            let pressTimer = null;
            let isLongPress = false;
            let deleteIndicator = null;

            const startPress = () => {
                isLongPress = false;
                deleteIndicator = document.createElement('div');
                deleteIndicator.className = 'emoji-delete-indicator';
                deleteIndicator.textContent = '🗑️';
                btn.appendChild(deleteIndicator);
                setTimeout(() => deleteIndicator.classList.add('show'), 10);
                pressTimer = setTimeout(() => {
                    isLongPress = true;
                    if (deleteIndicator) {
                        deleteIndicator.remove();
                        deleteIndicator = null;
                    }
                    onDelete(index);
                }, 800);
            };

            const cancelPress = () => {
                if (pressTimer) {
                    clearTimeout(pressTimer);
                    pressTimer = null;
                }
                if (deleteIndicator) {
                    deleteIndicator.classList.remove('show');
                    setTimeout(() => {
                        if (deleteIndicator && deleteIndicator.parentNode) {
                            deleteIndicator.remove();
                        }
                        deleteIndicator = null;
                    }, 200);
                }
            };

            btn.addEventListener('mousedown', startPress);
            btn.addEventListener('touchstart', startPress, { passive: true });
            btn.addEventListener('mouseup', cancelPress);
            btn.addEventListener('mouseleave', cancelPress);
            btn.addEventListener('touchend', cancelPress);
            btn.addEventListener('touchcancel', cancelPress);
            btn.addEventListener('click', async () => {
                if (!isLongPress) {
                    await onClick(emojiItem);
                }
            });
            grid.appendChild(btn);
        });

        const maxEmojiCount = 12 * 5;
        if (emojis.length < maxEmojiCount) {
            const addBtn = document.createElement('button');
            addBtn.className = 'btn-base btn-glass emoji-button emoji-add-button';
            addBtn.textContent = '+';
            addBtn.addEventListener('click', () => onAdd());
            grid.appendChild(addBtn);
        }
    }

    function saveEmojis(emojis) {
        localStorage.setItem('emojis', JSON.stringify(emojis));
    }

    function saveTodoItems(todoItems) {
        localStorage.setItem('todoItems', JSON.stringify(todoItems));
    }

    function createEmojiUploadProgress(filesToProcess) {
        const progressContainer = document.createElement('div');
        progressContainer.id = 'uploadProgressContainer';
        progressContainer.style.cssText = `
            margin-top: 20px;
            padding: 16px;
            background: rgba(0, 0, 0, 0.2);
            border-radius: 12px;
        `;
        progressContainer.innerHTML = `
            <div style="margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center;">
                <span style="font-size: 16px; color: var(--text-secondary);">上传进度</span>
                <span id="uploadProgressText" style="font-size: 16px; font-weight: 600; color: var(--accent-blue);">0 / ${filesToProcess}</span>
            </div>
            <div style="background: rgba(255,255,255,0.1); height: 8px; border-radius: 4px; overflow: hidden;">
                <div id="uploadProgressBar" style="width: 0%; height: 100%; background: var(--accent-blue); transition: width 0.3s ease;"></div>
            </div>
        `;
        return progressContainer;
    }

    function updateEmojiUploadProgress(processed, total) {
        const progressBar = document.getElementById('uploadProgressBar');
        const progressText = document.getElementById('uploadProgressText');
        if (!progressBar || !progressText) return;
        const percentage = total > 0 ? (processed / total) * 100 : 0;
        progressBar.style.width = percentage + '%';
        progressText.textContent = `${processed} / ${total}`;
    }

    function closeMainModalSilently() {
        const modal = document.getElementById('modal');
        if (modal) {
            modal.classList.remove('active');
        }
    }

    function buildWallpaperModal(currentBg, presetWallpapers) {
        const root = document.createElement('div');
        root.className = 'wallpaper-settings-grid';

        const left = document.createElement('div');
        left.className = 'stack-panel';

        const previewSection = document.createElement('div');
        previewSection.className = 'wallpaper-section';
        previewSection.innerHTML = `
            <div class="wallpaper-section-title">
                <span class="wallpaper-icon">👁️</span>
                <span>实时预览</span>
            </div>
            <div id="wallpaperPreview" class="wallpaper-preview">
                <span class="wallpaper-preview-text">壁纸预览</span>
            </div>
        `;
        left.appendChild(previewSection);

        const presetSection = document.createElement('div');
        presetSection.className = 'wallpaper-section';
        const presetTitle = document.createElement('div');
        presetTitle.className = 'wallpaper-section-title';
        presetTitle.innerHTML = '<span class="wallpaper-icon">📦</span><span>预设壁纸</span>';
        presetSection.appendChild(presetTitle);
        const grid = document.createElement('div');
        grid.id = 'wallpaperGrid';
        grid.className = 'wallpaper-presets-grid';
        presetWallpapers.forEach((wp, idx) => {
            const item = document.createElement('div');
            item.className = `wallpaper-preset-item ${currentBg === wp.value ? 'active' : ''}`;
            item.dataset.index = String(idx);
            item.style.background = wp.value;
            item.innerHTML = `<div class="wallpaper-preset-name">${window.UIComponents.escapeHtml(wp.name)}</div><div class="wallpaper-preset-check">✓</div>`;
            grid.appendChild(item);
        });
        presetSection.appendChild(grid);
        left.appendChild(presetSection);

        const right = document.createElement('div');
        right.className = 'stack-panel';
        right.innerHTML = `
            <div class="wallpaper-section">
                <div class="wallpaper-section-title">
                    <span class="wallpaper-icon">📤</span>
                    <span>本地图片</span>
                </div>
                <input type="file" id="localImageUpload" accept="image/*" style="display: none;">
                <button class="btn-base btn-sm btn-primary btn-block wallpaper-action-btn" id="openLocalWallpaperBtn">
                    <span class="btn-icon">📁</span>
                    <span>选择本地图片</span>
                </button>
                <div class="wallpaper-hint">支持 JPG、PNG、GIF 格式</div>
            </div>
            <div class="wallpaper-section">
                <div class="wallpaper-section-title">
                    <span class="wallpaper-icon">🎨</span>
                    <span>纯色壁纸</span>
                </div>
                <div class="wallpaper-color-group">
                    <input type="color" id="customColor" value="#1c1c1e" class="wallpaper-color-picker">
                    <button class="btn-base btn-sm btn-primary wallpaper-color-btn" id="applyWallpaperColorBtn">应用</button>
                </div>
            </div>
            <div class="wallpaper-section">
                <div class="wallpaper-section-title">
                    <span class="wallpaper-icon">🌐</span>
                    <span>图片URL</span>
                </div>
                <input type="text" id="customImageUrl" class="input-base control-sm" placeholder="输入图片URL..." style="margin-bottom: 8px;">
                <button class="btn-base btn-sm btn-primary btn-block wallpaper-action-btn" id="applyWallpaperImageBtn">
                    <span class="btn-icon">🔗</span>
                    <span>应用网络图片</span>
                </button>
            </div>
            <div class="wallpaper-section">
                <button class="btn-base btn-sm btn-secondary btn-block wallpaper-action-btn" id="resetWallpaperBtn">
                    <span class="btn-icon">↻</span>
                    <span>恢复默认壁纸</span>
                </button>
            </div>
        `;

        root.appendChild(left);
        root.appendChild(right);
        return root;
    }

    function updateWallpaperPreview(value) {
        const preview = document.getElementById('wallpaperPreview');
        if (!preview) return;
        if (value.startsWith('url(')) {
            preview.style.background = value;
            preview.style.backgroundSize = 'cover';
            preview.style.backgroundPosition = 'center';
        } else {
            preview.style.background = value;
            preview.style.backgroundSize = 'auto';
        }
    }

    function readWallpaperInputs() {
        return {
            color: document.getElementById('customColor')?.value || '#1c1c1e',
            imageUrl: (document.getElementById('customImageUrl')?.value || '').trim(),
            localFile: document.getElementById('localImageUpload')?.files?.[0] || null,
        };
    }

    function validateLocalWallpaperFile(file) {
        if (!file) return '请选择图片文件';
        if (!file.type.match('image.*')) return '请选择图片文件';
        if (file.size > 5 * 1024 * 1024) return '图片大小不能超过5MB';
        return '';
    }

    function applyWallpaper(value) {
        const body = document.body;
        if (value.startsWith('url(')) {
            body.style.background = value;
            body.style.backgroundSize = 'cover';
            body.style.backgroundPosition = 'center';
            body.style.backgroundRepeat = 'no-repeat';
            body.style.backgroundAttachment = 'fixed';
        } else {
            body.style.background = value;
            body.style.backgroundSize = 'auto';
            body.style.backgroundAttachment = 'auto';
        }
        localStorage.setItem('wallpaper', value);
    }

    function loadSavedWallpaper(defaultWallpaper) {
        const savedWallpaper = localStorage.getItem('wallpaper');
        const wallpaper = savedWallpaper || defaultWallpaper || (window.DEFAULT_WALLPAPER || '');
        applyWallpaper(wallpaper);
        if (!savedWallpaper) {
            localStorage.setItem('wallpaper', wallpaper);
        }
        return wallpaper;
    }

    function handleLocalWallpaperFile(file) {
        const error = validateLocalWallpaperFile(file);
        if (error) {
            return { ok: false, message: error };
        }
        return { ok: true };
    }

    function readLocalWallpaperFile(file, handlers) {
        const { onLoad, onError } = handlers || {};
        const reader = new FileReader();
        reader.onload = (event) => {
            if (typeof onLoad === 'function') {
                onLoad(event.target?.result || '');
            }
        };
        reader.onerror = () => {
            if (typeof onError === 'function') {
                onError();
            }
        };
        reader.readAsDataURL(file);
    }

    function updateSavedWallpaperPreviewFromCurrent() {
        const savedWallpaper = localStorage.getItem('wallpaper');
        const wallpaper = savedWallpaper || (window.DEFAULT_WALLPAPER || '');
        updateWallpaperPreview(wallpaper);
    }

    function applyCustomColor() {
        const color = document.getElementById('customColor')?.value || '#1c1c1e';
        applyWallpaper(color);
        updateWallpaperPreview(color);
        return color;
    }

    function applyCustomImage() {
        const imageUrl = (document.getElementById('customImageUrl')?.value || '').trim();
        if (!imageUrl) {
            return { ok: false, message: '请输入图片URL' };
        }
        try {
            new URL(imageUrl);
            const wallpaperValue = `url('${imageUrl}')`;
            applyWallpaper(wallpaperValue);
            updateWallpaperPreview(wallpaperValue);
            return { ok: true, value: wallpaperValue };
        } catch {
            return { ok: false, message: '无效的URL格式' };
        }
    }

    function resetWallpaper(defaultWallpaper) {
        const wallpaper = defaultWallpaper || (window.DEFAULT_WALLPAPER || '');
        applyWallpaper(wallpaper);
        updateWallpaperPreview(wallpaper);
        return wallpaper;
    }

    function buildColorPickerModal(presetColors, currentHue, currentSaturation, currentBrightness, recentColors) {
        const root = document.createElement('div');
        root.className = 'color-picker-container';

        const left = document.createElement('div');
        left.className = 'color-picker-left';
        left.innerHTML = `
            <div class="color-preview" id="colorPreview"></div>
            <div class="color-value-display">
                <div class="color-value-hex" id="colorValueHex">#0A84FF</div>
                <div class="color-value-rgb" id="colorValueRgb">RGB(10, 132, 255)</div>
            </div>
        `;

        const middle = document.createElement('div');
        middle.className = 'color-picker-middle';
        middle.innerHTML = `
            <div class="color-palette-section">
                <div class="color-section-title">最近使用</div>
                <div class="color-recent-grid" id="recentPalette"></div>
            </div>
            <div class="color-palette-section">
                <div class="color-section-title">HSB 调色</div>
                <div class="color-slider-group">
                    <div class="color-slider-icon">🌈</div>
                    <div class="slider-wrapper">
                        <div class="color-slider-track hue-track">
                            <input type="range" id="hueSlider" min="0" max="360" value="${currentHue}" class="horizontal-slider-compact">
                        </div>
                    </div>
                    <div class="color-slider-value" id="hueValue">${currentHue}°</div>
                </div>
                <div class="color-slider-group">
                    <div class="color-slider-icon">💧</div>
                    <div class="slider-wrapper">
                        <div class="color-slider-track saturation-track" id="saturationTrack">
                            <input type="range" id="saturationSlider" min="0" max="100" value="${currentSaturation}" class="horizontal-slider-compact">
                        </div>
                    </div>
                    <div class="color-slider-value" id="saturationValue">${currentSaturation}%</div>
                </div>
                <div class="color-slider-group">
                    <div class="color-slider-icon">☀️</div>
                    <div class="slider-wrapper">
                        <div class="color-slider-track brightness-track" id="brightnessTrack">
                            <input type="range" id="brightnessSlider" min="0" max="100" value="${currentBrightness}" class="horizontal-slider-compact">
                        </div>
                    </div>
                    <div class="color-slider-value" id="brightnessValue">${currentBrightness}%</div>
                </div>
            </div>
            <div class="color-actions">
                <button class="btn-base btn-sm btn-secondary" id="resetColorPickerBtn"><span>重置</span></button>
                <button class="btn-base btn-sm btn-primary" id="copyColorValueBtn"><span>复制颜色</span></button>
            </div>
        `;

        const right = document.createElement('div');
        right.className = 'color-picker-right';
        right.innerHTML = `
            <div class="color-palette-section">
                <div class="color-section-title">预设色板</div>
                <div class="color-palette-grid" id="presetPalette"></div>
            </div>
        `;

        root.appendChild(left);
        root.appendChild(middle);
        root.appendChild(right);
        return root;
    }

    function initColorPicker(state, handlers) {
        const hueSlider = document.getElementById('hueSlider');
        const saturationSlider = document.getElementById('saturationSlider');
        const brightnessSlider = document.getElementById('brightnessSlider');
        if (!hueSlider || !saturationSlider || !brightnessSlider) return;

        const { presetColors, recentColors } = state;
        const { onStateChange } = handlers || {};

        renderPresetColors(document.getElementById('presetPalette'), presetColors, (hex) => {
            const next = selectColor(hex, state);
            if (next && typeof onStateChange === 'function') onStateChange(next);
        });
        renderRecentColors(document.getElementById('recentPalette'), recentColors, (hex) => {
            const next = selectColor(hex, state);
            if (next && typeof onStateChange === 'function') onStateChange(next);
        });

        updateColorDisplay(state);

        hueSlider.oninput = (e) => {
            state.currentHue = parseInt(e.target.value);
            updateColorDisplay(state);
            if (typeof onStateChange === 'function') onStateChange(state);
        };
        saturationSlider.oninput = (e) => {
            state.currentSaturation = parseInt(e.target.value);
            updateColorDisplay(state);
            if (typeof onStateChange === 'function') onStateChange(state);
        };
        brightnessSlider.oninput = (e) => {
            state.currentBrightness = parseInt(e.target.value);
            updateColorDisplay(state);
            if (typeof onStateChange === 'function') onStateChange(state);
        };

        const resetBtn = document.getElementById('resetColorPickerBtn');
        if (resetBtn && !resetBtn.dataset.bound) {
            resetBtn.addEventListener('click', () => {
                resetColorPicker();
                if (typeof onStateChange === 'function') {
                    onStateChange({ currentHue: 210, currentSaturation: 100, currentBrightness: 100 });
                }
            });
            resetBtn.dataset.bound = '1';
        }

        const copyBtn = document.getElementById('copyColorValueBtn');
        if (copyBtn && !copyBtn.dataset.bound) {
            copyBtn.addEventListener('click', () => {
                copyColorValue();
                if (Array.isArray(state.recentColors)) {
                    const colorValue = document.getElementById('colorValueHex')?.textContent || '';
                    state.recentColors = rememberRecentColor(state.recentColors, colorValue);
                    renderRecentColors(document.getElementById('recentPalette'), state.recentColors, (hex) => {
                        const next = selectColor(hex, state);
                        if (next && typeof onStateChange === 'function') onStateChange(next);
                    });
                    if (typeof onStateChange === 'function') onStateChange(state);
                }
            });
            copyBtn.dataset.bound = '1';
        }
    }

    function renderColorPickerSwatches(container, colors, onSelect) {
        if (!container) return;
        container.innerHTML = colors.map((color) => `
            <div class="color-swatch" style="background: ${color};" data-color="${color}"></div>
        `).join('');
        container.querySelectorAll('.color-swatch').forEach((swatch) => {
            swatch.addEventListener('click', () => onSelect(swatch.getAttribute('data-color')));
        });
    }

    function renderPresetColors(container, presetColors, onSelect) {
        renderColorPickerSwatches(container, Array.isArray(presetColors) ? presetColors : [], onSelect);
    }

    function renderRecentColors(container, recentColors, onSelect) {
        renderColorPickerSwatches(container, Array.isArray(recentColors) ? recentColors : [], onSelect);
    }

    function rememberRecentColor(recentColors, colorValue) {
        const color = String(colorValue || '').trim().toUpperCase();
        const colors = Array.isArray(recentColors) ? recentColors : [];
        if (!/^#[0-9A-F]{6}$/.test(color)) {
            return colors;
        }
        const next = [color, ...colors.filter((item) => String(item).toUpperCase() !== color)].slice(0, 12);
        saveRecentColors(next);
        return next;
    }

    function saveRecentColors(recentColors) {
        localStorage.setItem('recentColors', JSON.stringify(recentColors));
    }

    function updateColorDisplay(hsbState) {
        const { currentHue, currentSaturation, currentBrightness } = hsbState;
        const [r, g, b] = (function hsbToRgb(h, s, b) {
            s = s / 100;
            b = b / 100;
            const k = (n) => (n + h / 60) % 6;
            const f = (n) => b * (1 - s * Math.max(0, Math.min(k(n), 4 - k(n), 1)));
            return [
                Math.round(255 * f(5)),
                Math.round(255 * f(3)),
                Math.round(255 * f(1))
            ];
        })(currentHue, currentSaturation, currentBrightness);
        const hex = '#' + [r, g, b].map((x) => {
            const h = x.toString(16);
            return h.length === 1 ? '0' + h : h;
        }).join('').toUpperCase();
        const preview = document.getElementById('colorPreview');
        if (preview) preview.style.background = hex;
        const hexDisplay = document.getElementById('colorValueHex');
        const rgbDisplay = document.getElementById('colorValueRgb');
        if (hexDisplay) hexDisplay.textContent = hex;
        if (rgbDisplay) rgbDisplay.textContent = `RGB(${r}, ${g}, ${b})`;
        const saturationTrack = document.getElementById('saturationTrack');
        const brightnessTrack = document.getElementById('brightnessTrack');
        if (saturationTrack) {
            const [r0, g0, b0] = (function hsbToRgb(h, s, b) {
                s = s / 100;
                b = b / 100;
                const k = (n) => (n + h / 60) % 6;
                const f = (n) => b * (1 - s * Math.max(0, Math.min(k(n), 4 - k(n), 1)));
                return [Math.round(255 * f(5)), Math.round(255 * f(3)), Math.round(255 * f(1))];
            })(currentHue, 0, currentBrightness);
            const [r100, g100, b100] = (function hsbToRgb(h, s, b) {
                s = s / 100;
                b = b / 100;
                const k = (n) => (n + h / 60) % 6;
                const f = (n) => b * (1 - s * Math.max(0, Math.min(k(n), 4 - k(n), 1)));
                return [Math.round(255 * f(5)), Math.round(255 * f(3)), Math.round(255 * f(1))];
            })(currentHue, 100, currentBrightness);
            saturationTrack.style.background = `linear-gradient(to right, rgb(${r0},${g0},${b0}), rgb(${r100},${g100},${b100}))`;
        }
        if (brightnessTrack) {
            const [r0, g0, b0] = (function hsbToRgb(h, s, b) {
                s = s / 100;
                b = b / 100;
                const k = (n) => (n + h / 60) % 6;
                const f = (n) => b * (1 - s * Math.max(0, Math.min(k(n), 4 - k(n), 1)));
                return [Math.round(255 * f(5)), Math.round(255 * f(3)), Math.round(255 * f(1))];
            })(currentHue, currentSaturation, 0);
            const [r100, g100, b100] = (function hsbToRgb(h, s, b) {
                s = s / 100;
                b = b / 100;
                const k = (n) => (n + h / 60) % 6;
                const f = (n) => b * (1 - s * Math.max(0, Math.min(k(n), 4 - k(n), 1)));
                return [Math.round(255 * f(5)), Math.round(255 * f(3)), Math.round(255 * f(1))];
            })(currentHue, currentSaturation, 100);
            brightnessTrack.style.background = `linear-gradient(to right, rgb(${r0},${g0},${b0}), rgb(${r100},${g100},${b100}))`;
        }
        const hueValue = document.getElementById('hueValue');
        const saturationValue = document.getElementById('saturationValue');
        const brightnessValue = document.getElementById('brightnessValue');
        if (hueValue) hueValue.textContent = `${currentHue}°`;
        if (saturationValue) saturationValue.textContent = `${currentSaturation}%`;
        if (brightnessValue) brightnessValue.textContent = `${currentBrightness}%`;
    }

    function selectColor(hex, state) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        if (!result) return state;
        const rgb = {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16),
        };
        const r = rgb.r / 255;
        const g = rgb.g / 255;
        const b = rgb.b / 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const delta = max - min;
        const next = { ...state };
        next.currentBrightness = Math.round(max * 100);
        next.currentSaturation = max === 0 ? 0 : Math.round((delta / max) * 100);
        if (delta === 0) {
            next.currentHue = 0;
        } else if (max === r) {
            next.currentHue = Math.round(60 * (((g - b) / delta) % 6));
        } else if (max === g) {
            next.currentHue = Math.round(60 * (((b - r) / delta) + 2));
        } else {
            next.currentHue = Math.round(60 * (((r - g) / delta) + 4));
        }
        if (next.currentHue < 0) next.currentHue += 360;
        const hueSlider = document.getElementById('hueSlider');
        const saturationSlider = document.getElementById('saturationSlider');
        const brightnessSlider = document.getElementById('brightnessSlider');
        if (hueSlider) hueSlider.value = next.currentHue;
        if (saturationSlider) saturationSlider.value = next.currentSaturation;
        if (brightnessSlider) brightnessSlider.value = next.currentBrightness;
        updateColorDisplay(next);
        return next;
    }

    function resetColorPicker() {
        const hueSlider = document.getElementById('hueSlider');
        const saturationSlider = document.getElementById('saturationSlider');
        const brightnessSlider = document.getElementById('brightnessSlider');
        if (hueSlider) hueSlider.value = 210;
        if (saturationSlider) saturationSlider.value = 100;
        if (brightnessSlider) brightnessSlider.value = 100;
        updateColorDisplay({ currentHue: 210, currentSaturation: 100, currentBrightness: 100 });
    }

    function copyColorValue() {
        const colorValue = document.getElementById('colorValueHex')?.textContent || '';
        navigator.clipboard.writeText(colorValue).then(() => {
            showToast('颜色代码已复制: ' + colorValue);
        }).catch(() => {
            showToast('复制失败');
        });
    }

    function bindWallpaperControls(presetWallpapers, handlers) {
        const { onApplyWallpaper, onUpdatePreview, onLocalUpload, onApplyColor, onApplyImage, onReset } = handlers;

        document.querySelectorAll('.wallpaper-preset-item').forEach((option) => {
            option.addEventListener('click', (e) => {
                const index = parseInt(e.currentTarget.dataset.index);
                const wallpaper = presetWallpapers[index];
                onApplyWallpaper(wallpaper.value);
                onUpdatePreview(wallpaper.value);
                document.querySelectorAll('.wallpaper-preset-item').forEach((opt) => {
                    opt.classList.remove('active');
                });
                e.currentTarget.classList.add('active');
            });
        });

        const fileInput = document.getElementById('localImageUpload');
        if (fileInput && !fileInput.dataset.bound) {
            fileInput.addEventListener('change', onLocalUpload);
            fileInput.dataset.bound = '1';
        }
        const openLocalBtn = document.getElementById('openLocalWallpaperBtn');
        if (openLocalBtn && fileInput && !openLocalBtn.dataset.bound) {
            openLocalBtn.addEventListener('click', () => fileInput.click());
            openLocalBtn.dataset.bound = '1';
        }
        const colorBtn = document.getElementById('applyWallpaperColorBtn');
        if (colorBtn && !colorBtn.dataset.bound) {
            colorBtn.addEventListener('click', onApplyColor);
            colorBtn.dataset.bound = '1';
        }
        const imageBtn = document.getElementById('applyWallpaperImageBtn');
        if (imageBtn && !imageBtn.dataset.bound) {
            imageBtn.addEventListener('click', onApplyImage);
            imageBtn.dataset.bound = '1';
        }
        const resetBtn = document.getElementById('resetWallpaperBtn');
        if (resetBtn && !resetBtn.dataset.bound) {
            resetBtn.addEventListener('click', onReset);
            resetBtn.dataset.bound = '1';
        }
    }

    function bindTodoList(listEl, handlers) {
        if (!listEl || listEl.dataset.bound === '1') return;
        const { onToggle, onDelete } = handlers;
        listEl.addEventListener('click', (event) => {
            const item = event.target.closest('.todo-item');
            const actionEl = event.target.closest('[data-todo-action]');
            const id = item?.getAttribute('data-todo-id');
            const action = actionEl?.getAttribute('data-todo-action');
            if (!id || !action) return;
            if (action === 'toggle') onToggle(Number(id));
            if (action === 'delete') onDelete(Number(id));
        });
        listEl.dataset.bound = '1';
    }

    return {
        buildEmojiModal,
        readEmojiFormValues,
        renderEmojiGrid,
        saveEmojis,
        renderTodoList,
        bindTodoList,
        saveTodoItems,
        createEmojiUploadProgress,
        updateEmojiUploadProgress,
        closeMainModalSilently,
        buildWallpaperModal,
        updateWallpaperPreview,
        readWallpaperInputs,
        validateLocalWallpaperFile,
        handleLocalWallpaperFile,
        readLocalWallpaperFile,
        applyWallpaper,
        loadSavedWallpaper,
        updateSavedWallpaperPreviewFromCurrent,
        applyCustomColor,
        applyCustomImage,
        resetWallpaper,
        buildColorPickerModal,
        initColorPicker,
        renderColorPickerSwatches,
        renderPresetColors,
        renderRecentColors,
        selectColor,
        saveRecentColors,
        rememberRecentColor,
        updateColorDisplay,
        resetColorPicker,
        copyColorValue,
        bindWallpaperControls,
    };
})();
