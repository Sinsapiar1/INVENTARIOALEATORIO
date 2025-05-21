/**
 * Verificador de Inventario de Pallets - Versión Mejorada 2025
 * 
 * Este código implementa un sistema de escaneo de códigos de barras para inventario
 * con manejo robusto de errores, mejor rendimiento y experiencia de usuario mejorada
 */

document.addEventListener('DOMContentLoaded', () => {
    // ================= ELEMENTOS DOM =================
    const UI = {
        startScanButton: document.getElementById('startScanButton'),
        stopScanButton: document.getElementById('stopScanButton'),
        scannerContainer: document.getElementById('scannerContainer'),
        video: document.getElementById('scannerVideo'),
        canvasElement: document.getElementById('scannerCanvas'),
        manualPalletIdInput: document.getElementById('manualPalletIdInput'),
        checkManualButton: document.getElementById('checkManualButton'),
        resultDisplay: document.getElementById('resultDisplay'),
        palletSummary: document.getElementById('palletSummary'),
        loadingIndicator: document.getElementById('loadingIndicator'),
        sessionScannedListElement: document.getElementById('sessionScannedList'),
        finishSessionButton: document.getElementById('finishSessionButton'),
        sessionResultDisplay: document.getElementById('sessionResultDisplay'),
        resetAppButton: document.getElementById('resetAppButton') // Botón de emergencia que añadiremos al HTML
    };

    // Crear contexto de canvas si el elemento existe
    const canvasContext = UI.canvasElement ? UI.canvasElement.getContext('2d') : null;

    // ================= CONFIGURACIÓN =================
    const CONFIG = {
        APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbxLFasO1SNvthuC0U54Sqa6igGTk909bHiGX4-nuCOmdsyZ2lXi5Cu5E7AZSc81GtpjMg/exec',
        API_KEY_FOR_SCRIPT: 'TuClaveSecretaInventadaSuperLarga123!@#', 
        SPREADSHEET_ID_FOR_LOG_LINK: "19DyoMu1V7xI5MrnbUvRTCjcKIboQKXS3QjdZt3zc-F4",
        LOG_SHEET_GID_FOR_LOG_LINK: "1250649243",
        SCANNER_SETTINGS: {
            // Configuración optimizada para mejor rendimiento
            readers: [
                "code_128_reader",
                "ean_reader",
                "ean_8_reader",
                "code_39_reader",
                "code_39_vin_reader",
                "codabar_reader",
                "upc_reader",
                "upc_e_reader",
                "i2of5_reader",
                "2of5_reader",
                "code_93_reader"
            ],
            locator: {
                patchSize: "medium",
                halfSample: true
            },
            locate: true,
            frequency: 10,
            numOfWorkers: Math.max(2, (navigator.hardwareConcurrency || 4) - 1) // Un thread menos que el máximo para evitar lag
        },
        SCAN_DEBOUNCE_TIME: 2500, // Tiempo en ms para permitir re-escanear el mismo código
        VIBRATION_DURATION: 50,    // Duración de la vibración en ms (para feedback táctil)
        ERROR_VIBRATION: [100, 50, 100] // Patrón para errores (ms)
    };

    // ================= ESTADO DE LA APLICACIÓN =================
    const AppState = {
        scanning: false,
        stream: null,
        scannedPalletsSessionData: [],
        lastScannedIdForTick: null,
        scanDebounceTimeout: null,
        quaggaScanner: null,
        barcodeScannerActive: false,
        lastError: null,
        isProcessingRequest: false
    };

    // ================= UTILITARIOS =================
    // Inicializar objetos de utilidad global
    if (!window.InventorySystem) window.InventorySystem = {};
    if (!window.InventorySystem.Utils) window.InventorySystem.Utils = {};

    // Sistema de logging mejorado
    const Logger = {
        log: (message, data) => {
            console.log(`[INFO] ${message}`, data || '');
        },
        error: (message, error) => {
            console.error(`[ERROR] ${message}`, error || '');
            AppState.lastError = { message, error, timestamp: new Date() };
        },
        warn: (message, data) => {
            console.warn(`[WARN] ${message}`, data || '');
        }
    };

    // Función para formatear números con localización
    if (!window.InventorySystem.Utils.formatNumber) {
        InventorySystem.Utils.formatNumber = function(num) {
            const parsedNum = parseFloat(num);
            if (isNaN(parsedNum) || num === null || num === undefined || num === '') return 'N/A';
            return Number(parsedNum).toLocaleString('es-ES', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
        };
    }

    // Función para feedback táctil (vibración) en dispositivos que lo soportan
    const vibrate = (pattern) => {
        if ('vibrate' in navigator) {
            try {
                navigator.vibrate(pattern);
            } catch (e) {
                Logger.warn('No se pudo activar la vibración', e);
            }
        }
    };

    // ================= FUNCIONES DE UI =================
    /**
     * Muestra un mensaje de resultado
     * @param {string} message - Mensaje a mostrar
     * @param {boolean} isError - Indica si es un mensaje de error
     * @param {boolean} withVibration - Indica si debe vibrar el dispositivo
     */
    function displayResult(message, isError = false, withVibration = true) {
        UI.resultDisplay.innerHTML = `<p class="${isError ? 'error' : 'success'}">${message}</p>`;
        
        if (withVibration) {
            if (isError) {
                vibrate(CONFIG.ERROR_VIBRATION);
            } else {
                vibrate(CONFIG.VIBRATION_DURATION);
            }
        }
    }

    /**
     * Muestra el resumen de un pallet escaneado
     * @param {Object} palletData - Datos del pallet
     */
    function displayPalletSummary(palletData) {
        UI.palletSummary.innerHTML = ''; 
        
        if (!palletData) {
            UI.palletSummary.innerHTML = '<p>Esperando escaneo o verificación...</p>';
            return;
        }
        
        if (palletData.found && palletData.products && palletData.products.length > 0) {
            // Generar estado y clase de color
            let statusColorClass = (palletData.statusSummary || 'mixto').toLowerCase().replace(/\s+/g, '-');
            
            // Construir HTML con template literals
            let html = `
                <div class="pallet-header">
                    <h4>ID Pallet: <span class="highlight">${palletData.id}</span></h4>
                    <p><strong>Estado General (Sistema):</strong> 
                       <span class="status-${statusColorClass}">${(palletData.statusSummary || 'Mixto').toUpperCase()}</span></p>
                    <p><strong>Productos en Pallet (Sistema): ${palletData.products.length}</strong></p>
                </div>
                <ul class="product-list">`;
            
            // Generar la lista de productos
            palletData.products.forEach((product, index) => {
                const systemQuantity = product["Inventario físico"];
                const systemQuantityFormatted = (systemQuantity !== undefined && systemQuantity !== '') 
                    ? InventorySystem.Utils.formatNumber(systemQuantity) 
                    : 'N/A';
                
                // Generar ID único seguro para input
                const productCode = product["Código de artículo"] 
                    ? product["Código de artículo"].replace(/[^a-zA-Z0-9-_]/g, '') 
                    : `item-${index}-${Date.now()}`;
                
                html += `
                    <li class="product-item">
                        <div class="product-info">
                            <p><strong>Cód. Artículo:</strong> ${product["Código de artículo"] || 'N/A'}</p>
                            <p><strong>Nombre:</strong> ${product["Nombre del producto"] || 'N/A'}</p>
                            <p>
                                <strong>Inv. Sist.:</strong> <span class="quantity">${systemQuantityFormatted}</span> | 
                                <strong>Disp. Sist.:</strong> ${product["Física disponible"] !== undefined && product["Física disponible"] !== '' 
                                    ? InventorySystem.Utils.formatNumber(product["Física disponible"]) 
                                    : 'N/A'}
                            </p>
                            <p>
                                <strong>Almacén:</strong> ${product["Almacén"] || 'N/A'}
                                ${product["Número de serie"] ? `| <strong>Nº Serie:</strong> ${product["Número de serie"]}` : ''}
                            </p>
                        </div>
                        <div class="quantity-input-container">
                            <label for="counted-${productCode}-${palletData.id}">Cant. Contada:</label>
                            <input type="number" min="0" inputmode="numeric" pattern="[0-9]*" id="counted-${productCode}-${palletData.id}" 
                                   class="counted-quantity-input" 
                                   data-pallet-id="${palletData.id}" 
                                   data-product-index="${index}" 
                                   placeholder="Físico" 
                                   value="${product.cantidadContada !== undefined ? product.cantidadContada : ''}">
                            <span id="diff-${productCode}-${palletData.id}" class="quantity-diff"></span>
                        </div>
                    </li>`;
            });
            
            html += '</ul>';
            UI.palletSummary.innerHTML = html;
            attachQuantityChangeListeners();
            
        } else if (palletData.id && palletData.found) {
            UI.palletSummary.innerHTML = `
                <div class="alert-box alert-info">
                    <p>Pallet <span class="highlight">${palletData.id}</span> encontrado, pero sin productos detallados o columnas vacías.</p>
                    <p>Estado: ${palletData.statusSummary || 'Desconocido'}</p>
                </div>`;
                
        } else if (palletData.id && !palletData.found) {
            UI.palletSummary.innerHTML = `
                <div class="alert-box alert-warning">
                    <p>Pallet <span class="highlight">${palletData.id}</span> NO ENCONTRADO en inventario maestro.</p>
                </div>`;
                
        } else {
            UI.palletSummary.innerHTML = '<p>Esperando escaneo o verificación...</p>';
        }
    }

    /**
     * Adjunta listeners de cambio a los inputs de cantidad contada
     */
    function attachQuantityChangeListeners() {
        document.querySelectorAll('.counted-quantity-input').forEach(input => {
            // Eliminar listeners previos para evitar duplicados
            input.removeEventListener('input', handleQuantityChange);
            input.addEventListener('input', handleQuantityChange);
            
            // Optimización para dispositivos móviles: seleccionar todo al hacer focus
            input.addEventListener('focus', function() {
                this.select();
            });
            
            // Optimización para teclados numéricos en móviles
            input.setAttribute('inputmode', 'numeric');
            input.setAttribute('pattern', '[0-9]*');
        });
    }

    /**
     * Maneja cambios en las cantidades contadas
     * @param {Event} e - Evento de cambio
     */
    function handleQuantityChange(e) {
        const input = e.target;
        const countedInput = input.value;
        const palletId = input.dataset.palletId;
        const productIndex = parseInt(input.dataset.productIndex, 10);

        // Verificar que el input es válido
        if (isNaN(productIndex) || !palletId) {
            Logger.error('Datos inválidos en input de cantidad', { palletId, productIndex });
            return;
        }

        const palletSessionEntry = AppState.scannedPalletsSessionData.find(p => p.id === palletId);
        if (!palletSessionEntry || !palletSessionEntry.products || !palletSessionEntry.products[productIndex]) {
            Logger.error('No se encontró el producto en la sesión', { palletId, productIndex });
            return;
        }
        
        const productInfo = palletSessionEntry.products[productIndex];
        
        // Manejar entrada vacía
        if (countedInput === '' || countedInput === null) {
            delete productInfo.cantidadContada;
        } else {
            // Convertir a número y verificar validez
            const counted = parseFloat(countedInput);
            if (!isNaN(counted)) {
                productInfo.cantidadContada = counted;
            } else {
                delete productInfo.cantidadContada;
            }
        }
        
        // Actualizar diferencia visual
        updateDifferenceDisplay(productInfo, productIndex, palletId);
        
        // Actualizar lista de sesión para mostrar productos contados
        updateSessionScannedList();
    }
    
    /**
     * Actualiza la visualización de diferencias entre cantidades
     */
    function updateDifferenceDisplay(productInfo, productIndex, palletId) {
        const systemQty = parseFloat(productInfo["Inventario físico"]);
        
        // Crear ID del elemento que muestra la diferencia
        const safeProductCode = productInfo["Código de artículo"] 
            ? productInfo["Código de artículo"].replace(/[^a-zA-Z0-9-_]/g, '')
            : `item-${productIndex}-${Date.now()}`;
        
        const diffElementId = `diff-${safeProductCode}-${palletId}`;
        const diffElement = document.getElementById(diffElementId);
        
        if (!diffElement) {
            Logger.warn(`Elemento de diferencia no encontrado: ${diffElementId}`);
            return;
        }

        // Mostrar diferencia si ambos valores son válidos
        if (productInfo.cantidadContada !== undefined && 
            !isNaN(productInfo.cantidadContada) && 
            !isNaN(systemQty)) {
            
            const diff = productInfo.cantidadContada - systemQty;
            diffElement.textContent = ` Dif: ${InventorySystem.Utils.formatNumber(diff)}`;
            
            // Aplicar clase según si hay discrepancia
            if (diff === 0) {
                diffElement.className = 'quantity-diff ok';
            } else {
                diffElement.className = 'quantity-diff discrepancy';
                // Vibrar ligeramente si hay discrepancia y es la primera vez que se detecta
                if (!diffElement.classList.contains('vibrated')) {
                    vibrate(50);
                    diffElement.classList.add('vibrated');
                }
            }
        } else if (productInfo.cantidadContada !== undefined && !isNaN(productInfo.cantidadContada)) {
            // Solo tenemos cantidad contada, sin sistema para comparar
            diffElement.textContent = ` (Contado: ${InventorySystem.Utils.formatNumber(productInfo.cantidadContada)})`;
            diffElement.className = 'quantity-diff discrepancy';
        } else {
            // No hay cantidad contada válida
            diffElement.textContent = '';
            diffElement.className = 'quantity-diff';
        }
    }
    
    /**
     * Actualiza la lista de pallets escaneados en esta sesión
     */
    function updateSessionScannedList() {
        UI.sessionScannedListElement.innerHTML = '';
        
        // Mostrar/ocultar botón de finalizar según si hay pallets
        if (AppState.scannedPalletsSessionData.length > 0) {
            UI.finishSessionButton.classList.remove('hidden');
        } else {
            UI.finishSessionButton.classList.add('hidden');
        }

        // Añadir cada pallet a la lista
        AppState.scannedPalletsSessionData.forEach((palletInfo, index) => {
            const listItem = document.createElement('li');
            
            // Determinar clase de estado para color
            let statusColorClass = 'status-noencontrado';
            let statusTextDisplay = 'NO ENCONTRADO (SISTEMA)';

            if (palletInfo.found) {
                statusColorClass = `status-${(palletInfo.statusSummary || 'mixto').toLowerCase().replace(/\s+/g, '-')}`;
                statusTextDisplay = (palletInfo.statusSummary || 'Mixto').toUpperCase();
            }
            
            // Contenido básico del ítem
            listItem.innerHTML = `
                <span class="pallet-index">${index + 1}.</span> 
                ID: <span class="highlight">${palletInfo.id}</span> - 
                Estado Sistema: <span class="${statusColorClass}">${statusTextDisplay}</span>`;
            
            // Añadir contador de productos si hay productos
            if (palletInfo.found && palletInfo.products && palletInfo.products.length > 0) {
                let itemsConConteo = palletInfo.products.filter(p => p.cantidadContada !== undefined).length;
                
                // Mostrar progreso de conteo
                listItem.innerHTML += ` 
                    <span class="count-progress">
                        (${palletInfo.products.length} tipo(s) prod. sistema / 
                         <span class="${itemsConConteo === palletInfo.products.length ? 'count-complete' : 'count-incomplete'}">
                            ${itemsConConteo} contado(s)
                         </span>)
                    </span>`;
            }
            
            UI.sessionScannedListElement.appendChild(listItem);
        });
    }

    // ================= FUNCIONES DE API Y DATOS =================
    /**
     * Verifica la información de un ID de pallet
     * @param {string} palletId - ID del pallet a verificar
     * @param {boolean} fromScan - Indica si viene de un escaneo automático
     */
    async function checkPalletId(palletId, fromScan = false) {
        const trimmedPalletId = palletId.trim();
        
        // Validar entrada
        if (!trimmedPalletId) {
            displayResult('Por favor, ingrese un ID de pallet.', true);
            return;
        }
        
        // Prevenir peticiones simultáneas
        if (AppState.isProcessingRequest) {
            displayResult('Procesando solicitud anterior, espere un momento...', true);
            return;
        }
        
        AppState.isProcessingRequest = true;
        
        // Mostrar indicador de carga y mensaje
        UI.loadingIndicator.classList.remove('hidden');
        displayResult(`Verificando ID: <span class="highlight">${trimmedPalletId}</span>...`, false, false);
        
        if (!fromScan) { 
            UI.palletSummary.innerHTML = '';
        }

        // Construir URL
        const url = `${CONFIG.APPS_SCRIPT_URL}?idpallet=${encodeURIComponent(trimmedPalletId)}&apiKey=${CONFIG.API_KEY_FOR_SCRIPT}`;
        Logger.log("Enviando solicitud", { id: trimmedPalletId });

        try {
            // Petición con timeout para evitar esperas infinitas
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 20000); // 20 segundos de timeout
            
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);
            
            // Procesar respuesta
            const dataFromServer = await response.json();
            UI.loadingIndicator.classList.add('hidden');
            Logger.log("Respuesta recibida", dataFromServer);

            // Manejar error del servidor
            if (dataFromServer.error) {
                displayResult(`Error desde el servidor: ${dataFromServer.error}`, true);
                const palletInfoError = { 
                    id: trimmedPalletId, 
                    found: false, 
                    products: [], 
                    statusSummary: "Error Servidor" 
                };
                
                // Solo añadir a la sesión si no existe ya un error similar
                const existingErrorIndex = AppState.scannedPalletsSessionData.findIndex(
                    p => p.id === trimmedPalletId && p.statusSummary === "Error Servidor"
                );
                
                if (existingErrorIndex === -1) {
                    AppState.scannedPalletsSessionData.push(palletInfoError);
                }
            } else {
                // Procesar datos válidos del pallet
                const palletInfoForSession = {
                    id: dataFromServer.id,
                    found: dataFromServer.found,
                    products: (dataFromServer.products || []).map(p_sistema => ({ 
                        ...p_sistema, 
                        cantidadContada: undefined 
                    })),
                    statusSummary: dataFromServer.statusSummary || (dataFromServer.found ? "Mixto" : "No Encontrado")
                };

                // Buscar si ya existe en la sesión
                const existingEntryIndex = AppState.scannedPalletsSessionData.findIndex(p => p.id === palletInfoForSession.id);
                
                if (existingEntryIndex > -1) {
                    // Actualizar pallet existente preservando cantidades contadas
                    const existingEntry = AppState.scannedPalletsSessionData[existingEntryIndex];
                    palletInfoForSession.products.forEach((newProdInfo, newProdIndex) => {
                        const existingProdInfo = existingEntry.products.find(
                            ep => ep["Código de artículo"] === newProdInfo["Código de artículo"]
                        );
                        if (existingProdInfo && existingProdInfo.cantidadContada !== undefined) {
                            newProdInfo.cantidadContada = existingProdInfo.cantidadContada;
                        }
                    });
                    AppState.scannedPalletsSessionData[existingEntryIndex] = palletInfoForSession;
                    displayResult(`Pallet ID: ${palletInfoForSession.id} RE-VERIFICADO. Estado Sistema: ${palletInfoForSession.statusSummary}.`, !palletInfoForSession.found);
                } else {
                    // Añadir nuevo pallet
                    AppState.scannedPalletsSessionData.push(palletInfoForSession);
                    displayResult(`Pallet ID: ${palletInfoForSession.id} ${palletInfoForSession.found ? 'ENCONTRADO' : 'NO ENCONTRADO'}. Estado: ${palletInfoForSession.statusSummary}.`, !palletInfoForSession.found);
                }
                
                // Mostrar detalles del pallet
                displayPalletSummary(palletInfoForSession);
            }
            
            // Actualizar la UI
            updateSessionScannedList();
            
        } catch (error) {
            // Manejar errores de red
            Logger.error('Error al verificar pallet', error);
            
            // Mostrar mensaje según tipo de error
            if (error.name === 'AbortError') {
                displayResult('La solicitud tardó demasiado. Verifique su conexión e intente nuevamente.', true);
            } else {
                displayResult('Error de conexión o al procesar la solicitud.', true);
            }
            
            UI.loadingIndicator.classList.add('hidden');
            
            // Registrar error en la sesión
            const palletInfoError = { 
                id: trimmedPalletId, 
                found: false, 
                products: [], 
                statusSummary: "Error Conexión" 
            };
            
            const existingErrorIndex = AppState.scannedPalletsSessionData.findIndex(
                p => p.id === trimmedPalletId && p.statusSummary === "Error Conexión"
            );
            
            if (existingErrorIndex === -1) {
                AppState.scannedPalletsSessionData.push(palletInfoError);
            }
            
            updateSessionScannedList();
        } finally {
            AppState.isProcessingRequest = false;
        }
    }

    // ================= FUNCIONES DE ESCANEO =================
    /**
     * Inicializa el escáner de códigos de barras Quagga
     */
    function initQuagga() {
        // Verificar disponibilidad de video
        if (!UI.video || UI.video.readyState === 0) {
            Logger.error('Elemento de video no disponible');
            displayResult("Error: elemento de video no disponible. Intente recargar la página.", true);
            return;
        }

        // Ajustar tamaño del canvas al video para precisión
        if (UI.canvasElement && UI.video.videoWidth > 0) {
            UI.canvasElement.width = UI.video.videoWidth;
            UI.canvasElement.height = UI.video.videoHeight;
        }

        // Configurar Quagga con opciones optimizadas
        Quagga.init({
            inputStream: {
                name: "Live",
                type: "LiveStream",
                target: UI.video,
                constraints: {
                    width: { min: 640 },
                    height: { min: 480 },
                    aspectRatio: { min: 1, max: 2 },
                    facingMode: "environment", // Usar cámara trasera en móviles
                    frameRate: { ideal: 15, max: 30 }
                },
            },
            locator: CONFIG.SCANNER_SETTINGS.locator,
            numOfWorkers: CONFIG.SCANNER_SETTINGS.numOfWorkers,
            frequency: CONFIG.SCANNER_SETTINGS.frequency,
            decoder: {
                readers: CONFIG.SCANNER_SETTINGS.readers,
                multiple: false
            },
            locate: CONFIG.SCANNER_SETTINGS.locate
        }, function(err) {
            // Manejar errores de inicialización
            if (err) {
                Logger.error("Error iniciando Quagga", err);
                displayResult(`Error al iniciar el escáner: ${err.message || 'Desconocido'}`, true);
                stopScanner();
                return;
            }
            
            // Éxito - iniciar escáner
            Logger.log("Quagga iniciado correctamente");
            try {
                Quagga.start();
                AppState.quaggaScanner = true;
                AppState.barcodeScannerActive = true;
                
                // Evento para detectar códigos escaneados
                Quagga.onDetected(handleQuaggaDetection);
                
                // Visualización opcional para depuración
                if (UI.canvasElement && canvasContext) {
                    Quagga.onProcessed(handleQuaggaProcessing);
                }
                
                // Hacer visible el canvas
                UI.canvasElement.classList.remove('hidden');
                
                // Feedback de éxito
                displayResult("Escáner activo. Apunte al código del pallet.", false);
                vibrate(100);
            } catch (startError) {
                Logger.error("Error al iniciar Quagga.start()", startError);
                displayResult("Error al iniciar el escáner. Intente de nuevo.", true);
                stopScanner();
            }
        });
    }

    /**
     * Procesa resultados intermedios del escaneo (visualización)
     */
    function handleQuaggaProcessing(result) {
        if (!canvasContext || !result) return;
        
        // Limpiar canvas
        canvasContext.clearRect(0, 0, UI.canvasElement.width, UI.canvasElement.height);
        
        // Dibujar boxes de detección
        if (result.boxes) {
            const hasResult = result.boxes.filter(box => box !== result.box).length > 0;
            
            if (hasResult) {
                result.boxes.forEach(box => {
                    canvasContext.strokeStyle = "rgba(0, 255, 0, 0.5)";
                    canvasContext.lineWidth = 2;
                    canvasContext.strokeRect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
                });
            }
        }
        
        // Resaltar box principal
        if (result.box) {
            canvasContext.strokeStyle = "rgba(0, 0, 255, 0.8)";
            canvasContext.lineWidth = 2;
            canvasContext.strokeRect(
                result.box.x, result.box.y,
                result.box.width, result.box.height
            );
        }
        
        // Mostrar código detectado
        if (result.codeResult && result.codeResult.code) {
            canvasContext.font = "16px Arial";
            canvasContext.fillStyle = "#00cc00";
            canvasContext.fillRect(0, 0, 220, 30);
            canvasContext.fillStyle = "#000000";
            canvasContext.fillText(`Código: ${result.codeResult.code}`, 10, 20);
        }
    }

    /**
     * Maneja la detección exitosa de un código de barras
     */
    function handleQuaggaDetection(result) {
        if (!result || !result.codeResult || !result.codeResult.code) return;
        
        const scannedCode = result.codeResult.code;
        Logger.log("Código detectado", scannedCode);
        
        // Prevenir escaneos repetidos del mismo código
        if (scannedCode !== AppState.lastScannedIdForTick) {
            AppState.lastScannedIdForTick = scannedCode;
            
            // Reproducir sonido de éxito si está disponible
            const successSound = document.getElementById('scanSuccessSound');
            if (successSound) {
                try {
                    successSound.play().catch(e => Logger.warn('No se pudo reproducir sonido', e));
                } catch (e) {
                    // Ignorar errores de reproducción
                }
            }
            
            // Vibrar para dar feedback
            vibrate(CONFIG.VIBRATION_DURATION);
            
            // Actualizar UI con el código escaneado
            UI.manualPalletIdInput.value = scannedCode;
            checkPalletId(scannedCode, true);
            
            // Reiniciar debounce para permitir escanear el mismo código después de un tiempo
            clearTimeout(AppState.scanDebounceTimeout);
            AppState.scanDebounceTimeout = setTimeout(() => {
                AppState.lastScannedIdForTick = null;
                displayResult("Listo para el siguiente escaneo...", false, false);
            }, CONFIG.SCAN_DEBOUNCE_TIME);
        }
    }

    /**
     * Inicia el escáner de códigos de barras
     */
    function startScanner() {
        // Limpiar pantalla
        UI.palletSummary.innerHTML = "";
        displayResult("Iniciando cámara...", false, false);

        // Verificar soporte para MediaDevices
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            displayResult("La función de escaneo no es soportada en este navegador.", true);
            return;
        }

        // Solicitar acceso a la cámara
        navigator.mediaDevices.getUserMedia({ 
            video: { 
                facingMode: "environment",
                width: { ideal: 1280, min: 640 },
                height: { ideal: 720, min: 480 },
                aspectRatio: { ideal: 16/9 }
            } 
        }).then(function(mediaStream) {
            AppState.stream = mediaStream;
            UI.video.srcObject = mediaStream;
            UI.video.setAttribute("playsinline", true); // Importante para iOS
            UI.video.play();
            
            AppState.scanning = true;
            AppState.lastScannedIdForTick = null;
            
            // Actualizar UI
            UI.scannerContainer.classList.remove('hidden');
            UI.startScanButton.classList.add('hidden');
            UI.stopScanButton.classList.remove('hidden'); 
            
            displayResult("Cámara activada. Apunte al código del pallet.", false, false);
            
            // Esperar a que el video esté listo antes de iniciar Quagga
            UI.video.onloadedmetadata = function() {
                // Adaptar tamaño del canvas al video
                if (UI.canvasElement) {
                    UI.canvasElement.width = UI.video.videoWidth;
                    UI.canvasElement.height = UI.video.videoHeight;
                }
                initQuagga();
            };
        }).catch(function(err) {
            Logger.error("Error al acceder a la cámara", err);
            
            let errorMsg = "Error al acceder a la cámara";
            if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                errorMsg = "Permiso de cámara denegado. Por favor, permita el acceso a la cámara.";
            } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
                errorMsg = "No se encontró ninguna cámara en este dispositivo.";
            } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
                errorMsg = "La cámara está en uso por otra aplicación.";
            } else if (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError') {
                errorMsg = "No se pudo acceder a la cámara con la configuración solicitada.";
            }
            
            displayResult(errorMsg, true);
            stopScanner();
        });
    }

    /**
     * Detiene el escáner de códigos de barras
     */
    function stopScanner() {
        Logger.log("Intentando detener el escáner...");
        
        try {
            // Indicar que no estamos escaneando
            AppState.scanning = false;
            AppState.barcodeScannerActive = false;
            
            // Eliminar listener de detección para evitar llamadas residuales
            if (AppState.quaggaScanner && typeof Quagga !== 'undefined') {
                try {
                    Quagga.offDetected(handleQuaggaDetection);
                    Quagga.offProcessed(handleQuaggaProcessing);
                } catch (listenerError) {
                    Logger.warn("Error al eliminar listeners de Quagga", listenerError);
                }
                
                // Detener Quagga
                try {
                    Quagga.stop();
                    Logger.log("Quagga detenido correctamente");
                } catch (stopError) {
                    Logger.error("Error al detener Quagga", stopError);
                }
                
                AppState.quaggaScanner = null;
            }
            
            // Detener stream de video
            if (AppState.stream) {
                try {
                    const tracks = AppState.stream.getTracks();
                    tracks.forEach(track => {
                        track.stop();
                        Logger.log(`Track de tipo ${track.kind} detenido`);
                    });
                } catch (trackError) {
                    Logger.error("Error al detener tracks de video", trackError);
                }
                AppState.stream = null;
            }
            
            // Limpiar elementos de UI
            if (UI.video) UI.video.srcObject = null;
            UI.scannerContainer.classList.add('hidden');
            UI.canvasElement.classList.add('hidden');
            UI.startScanButton.classList.remove('hidden');
            UI.stopScanButton.classList.add('hidden');
            
            // Limpiar timeouts
            clearTimeout(AppState.scanDebounceTimeout);
            
            // Mensaje de éxito
            displayResult("Escáner detenido.", false, false);
            Logger.log("Escáner detenido completamente");
            
        } catch (error) {
            // Manejo de errores durante la detención
            Logger.error("Error general al detener el escáner", error);
            
            // Fuerza una limpieza de emergencia
            try {
                if (UI.video) UI.video.srcObject = null;
                UI.scannerContainer.classList.add('hidden');
                UI.canvasElement.classList.add('hidden');
                UI.startScanButton.classList.remove('hidden');
                UI.stopScanButton.classList.add('hidden');
                
                AppState.scanning = false;
                AppState.quaggaScanner = null;
                AppState.stream = null;
                
                displayResult("Se produjo un error al detener el escáner, pero se ha recuperado.", true, true);
            } catch (e) {
                // Error crítico - recomendar recargar
                displayResult("Error crítico. Por favor, recargue la página.", true, true);
            }
        }
    }

    /**
     * Finaliza la sesión y procesa el conteo
     */
    async function finishAndProcessSession() {
        // Verificar que hay datos para procesar
        if (AppState.scannedPalletsSessionData.length === 0) {
            UI.sessionResultDisplay.innerHTML = "<p class='alert-box alert-warning'>No hay pallets escaneados en esta sesión para procesar.</p>";
            return;
        }

        // Detener el escáner si está activo
        if (AppState.scanning) {
            stopScanner();
        }
        
        // Mostrar carga y mensaje
        UI.loadingIndicator.classList.remove('hidden');
        UI.sessionResultDisplay.innerHTML = "<p>Procesando sesión y enviando datos al servidor...</p>";
        Logger.log("Iniciando procesamiento de sesión", { 
            pallets: AppState.scannedPalletsSessionData.length 
        });
    
        try {
            // Verificar conexión antes de enviar
            if (!navigator.onLine) {
                throw new Error("No hay conexión a internet. Verifique su conexión e intente nuevamente.");
            }
            
            // Configurar timeout para la solicitud
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 segundos timeout
            
            // Realizar solicitud POST
            const response = await fetch(CONFIG.APPS_SCRIPT_URL, {
                method: 'POST',
                body: JSON.stringify({ 
                    apiKey: CONFIG.API_KEY_FOR_SCRIPT,
                    action: 'processSessionWithQuantities',
                    sessionData: AppState.scannedPalletsSessionData 
                }),
                signal: controller.signal,
                redirect: 'follow'
            });
            
            // Limpiar timeout
            clearTimeout(timeoutId);

            // Verificar respuesta HTTP
            if (!response.ok) {
                const errorText = await response.text(); 
                throw new Error(`Error de servidor: ${response.status} ${response.statusText}. Respuesta: ${errorText}`);
            }
            
            // Procesar respuesta
            const result = await response.json();
            UI.loadingIndicator.classList.add('hidden');
            Logger.log("Respuesta de procesamiento de sesión", result);

            if (result.error) {
                // Error en la respuesta
                UI.sessionResultDisplay.innerHTML = `
                    <div class="alert-box alert-error">
                        <p>Error al procesar sesión: ${result.error}</p>
                    </div>`;
            } else if (result.success) {
                // Procesamiento exitoso
                let summaryHtml = `
                    <div class="session-summary">
                        <p><strong>Pallets Procesados:</strong> ${result.summary.palletsProcesados || 0}</p>
                        <p><strong>Items Procesados:</strong> ${result.summary.itemsProcesados || 0}</p>
                        <p><strong>Items OK (Conteo = Sistema):</strong> ${result.summary.itemsOk || 0}</p>
                        <p><strong>Items con Discrepancia:</strong> ${result.summary.itemsConDiscrepancia || 0}</p>
                    </div>`;
                
                // Link a la hoja de resultados
                const logSheetUrl = `https://docs.google.com/spreadsheets/d/${CONFIG.SPREADSHEET_ID_FOR_LOG_LINK}/edit#gid=${CONFIG.LOG_SHEET_GID_FOR_LOG_LINK}`;

                UI.sessionResultDisplay.innerHTML = `
                    <div class="alert-box alert-success">
                        <p>${result.message}</p>
                        ${summaryHtml}
                        <p><a href="${logSheetUrl}" target="_blank" class="btn btn-link">
                            <i class="icon-spreadsheet"></i> Ver Hoja de Resultados del Log
                        </a></p>
                    </div>`;
                
                // Limpiar datos de sesión
                AppState.scannedPalletsSessionData = [];
                updateSessionScannedList();
                displayResult("Sesión procesada. Puede iniciar una nueva.", false);
                UI.palletSummary.innerHTML = "";
                
                // Feedback táctil de éxito
                vibrate([100, 50, 100, 50, 100]);

            } else {
                // Respuesta inesperada
                UI.sessionResultDisplay.innerHTML = `
                    <div class="alert-box alert-warning">
                        <p>Respuesta inesperada del servidor al procesar sesión. Verifique el resultado en la hoja de cálculo.</p>
                    </div>`;
            }

        } catch (error) {
            // Manejar error en la solicitud
            Logger.error('Error al finalizar sesión', error);
            UI.loadingIndicator.classList.add('hidden');
            
            let errorMessage = error.message;
            
            // Mensajes específicos según el tipo de error
            if (error.name === 'AbortError') {
                errorMessage = "La solicitud tomó demasiado tiempo. El servidor podría estar ocupado.";
            } else if (!navigator.onLine) {
                errorMessage = "No hay conexión a internet. Verifique su red e intente nuevamente.";
            }
            
            UI.sessionResultDisplay.innerHTML = `
                <div class="alert-box alert-error">
                    <p>Error de conexión al finalizar sesión:</p>
                    <p>${errorMessage}</p>
                    <p>Los datos de la sesión siguen disponibles. Puede intentar enviarlos nuevamente.</p>
                </div>`;
                
            // Feedback táctil de error
            vibrate(CONFIG.ERROR_VIBRATION);
        }
    }

    /**
     * Resetea completamente la aplicación en caso de problemas
     */
    function resetApplication() {
        try {
            // Detener escáner si está activo
            if (AppState.scanning || AppState.barcodeScannerActive) {
                stopScanner();
            }
            
            // Restablecer valores de la interfaz
            UI.scannerContainer.classList.add('hidden');
            UI.canvasElement.classList.add('hidden');
            UI.loadingIndicator.classList.add('hidden');
            UI.startScanButton.classList.remove('hidden');
            UI.stopScanButton.classList.add('hidden');
            
            // Limpiar el stream de video
            if (AppState.stream) {
                try {
                    AppState.stream.getTracks().forEach(track => track.stop());
                } catch (e) {}
                AppState.stream = null;
            }
            
            if (UI.video) UI.video.srcObject = null;
            
            // Restablecer Quagga
            if (AppState.quaggaScanner && typeof Quagga !== 'undefined') {
                try {
                    Quagga.offDetected(handleQuaggaDetection);
                    Quagga.stop();
                } catch (e) {}
                AppState.quaggaScanner = null;
            }
            
            // Limpiar todos los timeouts
            clearTimeout(AppState.scanDebounceTimeout);
            
            // Mostrar mensaje de éxito
            displayResult("Aplicación reiniciada correctamente.", false);
            Logger.log("Aplicación reiniciada manualmente");
            
        } catch (error) {
            // Error crítico - recomendar recarga de página
            Logger.error("Error al reiniciar la aplicación", error);
            alert("Error crítico al reiniciar. Por favor, recargue la página.");
        }
    }

    // ================= INICIALIZACIÓN Y EVENT LISTENERS =================
    // Inicializar verificación de red
    window.addEventListener('online', () => {
        displayResult("Conexión a internet restablecida.", false);
    });
    
    window.addEventListener('offline', () => {
        displayResult("Sin conexión a internet. Algunas funciones no estarán disponibles.", true);
    });
    
    // Event Listeners con manejo mejorado
    UI.startScanButton.addEventListener('click', function(e) {
        e.preventDefault();
        if (AppState.scanning) return; // Prevenir inicios múltiples
        startScanner();
    });
    
    // Mejorar el event listener con un timeout para asegurar la respuesta
    UI.stopScanButton.addEventListener('click', function(e) {
        e.preventDefault(); // Prevenir comportamiento por defecto
        e.stopPropagation(); // Detener propagación
        
        // Desactivar el botón temporalmente para evitar clics múltiples
        UI.stopScanButton.disabled = true;
        
        // Llamar a la función de detención
        stopScanner();
        
        // Reactivar el botón después de un breve retraso
        setTimeout(() => {
            UI.stopScanButton.disabled = false;
        }, 1000);
    });
    
    UI.checkManualButton.addEventListener('click', function(e) {
        e.preventDefault();
        checkPalletId(UI.manualPalletIdInput.value.trim());
    });
    
    UI.manualPalletIdInput.addEventListener('keypress', function(event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            checkPalletId(UI.manualPalletIdInput.value.trim());
        }
    });
    
    UI.finishSessionButton.addEventListener('click', function(e) {
        e.preventDefault();
        finishAndProcessSession();
    });
    
    // Botón de reinicio de emergencia (si existe en el HTML)
    if (UI.resetAppButton) {
        UI.resetAppButton.addEventListener('click', function(e) {
            e.preventDefault();
            if (confirm("¿Está seguro de reiniciar la aplicación? Esto detendrá el escáner y reiniciará la interfaz.")) {
                resetApplication();
            }
        });
    }
    
    // Detectar cambios de orientación para optimizar el escáner
    window.addEventListener('orientationchange', function() {
        if (AppState.scanning) {
            // Reiniciar el escáner cuando cambia la orientación para adaptar tamaños
            Logger.log("Cambio de orientación detectado. Reiniciando escáner...");
            setTimeout(() => {
                stopScanner();
                setTimeout(() => {
                    startScanner();
                }, 500);
            }, 500);
        }
    });
    
    // Manejar teclas para detener escáner (Esc)
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && AppState.scanning) {
            stopScanner();
        }
    });
    
    // Inicialización adicional para mejorar la experiencia en dispositivos móviles
    document.addEventListener('visibilitychange', function() {
        // Detener el escáner cuando la página no está visible
        if (document.hidden && AppState.scanning) {
            Logger.log("Página no visible. Deteniendo escáner...");
            stopScanner();
        }
    });
    
    // Mensaje de inicialización
    Logger.log("Aplicación inicializada correctamente");
});
