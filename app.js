document.addEventListener('DOMContentLoaded', () => {
    const startScanButton = document.getElementById('startScanButton');
    const stopScanButton = document.getElementById('stopScanButton');
    const scannerContainer = document.getElementById('scannerContainer');
    const video = document.getElementById('scannerVideo');
    const canvasElement = document.getElementById('scannerCanvas');
    const canvasContext = canvasElement.getContext('2d');
    const manualPalletIdInput = document.getElementById('manualPalletIdInput');
    const checkManualButton = document.getElementById('checkManualButton');
    const resultDisplay = document.getElementById('resultDisplay');
    const palletSummary = document.getElementById('palletSummary');
    const loadingIndicator = document.getElementById('loadingIndicator');

    const sessionScannedListElement = document.getElementById('sessionScannedList');
    const finishSessionButton = document.getElementById('finishSessionButton');
    const sessionResultDisplay = document.getElementById('sessionResultDisplay');

    // ---------- CONFIGURACIÓN - ¡REEMPLAZA ESTOS VALORES! ----------
    const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxLFasO1SNvthuC0U54Sqa6igGTk909bHiGX4-nuCOmdsyZ2lXi5Cu5E7AZSc81GtpjMg/exec'; 
    const API_KEY_FOR_SCRIPT = 'TuClaveSecretaInventadaSuperLarga123!@#'; 
    const SPREADSHEET_ID_FOR_LOG_LINK = "19DyoMu1V7xI5MrnbUvRTCjcKIboQKXS3QjdZt3zc-F4"; 
    const LOG_SHEET_GID_FOR_LOG_LINK = "1250649243"; 
    // ---------------------------------------------------------------

    let scanning = false;
    let stream = null;
    let scannedPalletsSessionData = []; 
    let lastScannedIdForTick = null; 
    let scanDebounceTimeout = null;
    let quaggaScanner = null; // Variable para mantener referencia al escáner

    if (!window.InventorySystem) window.InventorySystem = {};
    if (!window.InventorySystem.Utils) window.InventorySystem.Utils = {};
    if (!window.InventorySystem.Utils.formatNumber) {
        InventorySystem.Utils.formatNumber = function(num) {
            const parsedNum = parseFloat(num);
            if (isNaN(parsedNum) || num === null || num === undefined || num === '') return 'N/A';
            return Number(parsedNum).toLocaleString('es-ES', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
        };
    }

    function displayResult(message, isError = false) {
        resultDisplay.innerHTML = `<p class="${isError ? 'error' : 'success'}">${message}</p>`;
    }

    function displayPalletSummary(palletData) {
        palletSummary.innerHTML = ''; 
        if (palletData && palletData.found && palletData.products && palletData.products.length > 0) {
            let statusColorClass = (palletData.statusSummary || 'mixto').toLowerCase().replace(/\s+/g, '-');
            let html = `<h4>ID Pallet: <span class="highlight">${palletData.id}</span></h4>`;
            html += `<p><strong>Estado General (Sistema):</strong> <span class="status-${statusColorClass}">${(palletData.statusSummary || 'Mixto').toUpperCase()}</span></p>`;
            html += `<p><strong>Productos en Pallet (Sistema): ${palletData.products.length}</strong></p>`;
            html += '<ul>';
            palletData.products.forEach((product, index) => {
                const systemQuantity = product["Inventario físico"];
                const systemQuantityFormatted = (systemQuantity !== undefined && systemQuantity !== '') ? InventorySystem.Utils.formatNumber(systemQuantity) : 'N/A';
                const productCode = product["Código de artículo"] || `item-${index}-${Date.now()}`; // ID único para input
                
                html += `<li>
                            <strong>Cód. Artículo:</strong> ${product["Código de artículo"] || 'N/A'}<br> 
                            <strong>Nombre:</strong> ${product["Nombre del producto"] || 'N/A'}<br>
                            <strong>Inv. Sist.:</strong> <span class="quantity">${systemQuantityFormatted}</span> | 
                            <strong>Disp. Sist.:</strong> ${product["Física disponible"] !== undefined && product["Física disponible"] !== '' ? InventorySystem.Utils.formatNumber(product["Física disponible"]) : 'N/A'}<br>
                            <strong>Almacén:</strong> ${product["Almacén"] || 'N/A'}
                            ${product["Número de serie"] ? `| <strong>Nº Serie:</strong> ${product["Número de serie"]}` : ''}<br>
                            <label for="counted-${productCode}-${palletData.id}">Cant. Contada:</label>
                            <input type="number" min="0" id="counted-${productCode}-${palletData.id}" class="counted-quantity-input" 
                                   data-pallet-id="${palletData.id}" data-product-index="${index}" placeholder="Físico" 
                                   value="${product.cantidadContada !== undefined ? product.cantidadContada : ''}">
                            <span id="diff-${productCode}-${palletData.id}" class="quantity-diff"></span>
                         </li>`;
            });
            html += '</ul>';
            palletSummary.innerHTML = html;
            attachQuantityChangeListeners();
        } else if (palletData && palletData.id && palletData.found) {
             palletSummary.innerHTML = `<p>Pallet <span class="highlight">${palletData.id}</span> encontrado, pero sin productos detallados o columnas vacías. Estado: ${palletData.statusSummary || 'Desconocido'}</p>`;
        } else if (palletData && !palletData.found) {
             palletSummary.innerHTML = `<p>Pallet <span class="highlight">${palletData.id}</span> NO ENCONTRADO en inventario maestro.</p>`;
        } else {
            palletSummary.innerHTML = '<p>Esperando escaneo o verificación...</p>';
        }
    }

    function attachQuantityChangeListeners() {
        document.querySelectorAll('.counted-quantity-input').forEach(input => {
            input.removeEventListener('input', handleQuantityChange); 
            input.addEventListener('input', handleQuantityChange);
        });
    }

    function handleQuantityChange(e) {
        const countedInput = e.target.value;
        const palletId = e.target.dataset.palletId;
        const productIndex = parseInt(e.target.dataset.productIndex, 10);

        const palletSessionEntry = scannedPalletsSessionData.find(p => p.id === palletId);
        if (palletSessionEntry && palletSessionEntry.products && palletSessionEntry.products[productIndex]) {
            const productInfo = palletSessionEntry.products[productIndex];
            
            if (countedInput === '' || countedInput === null) {
                 delete productInfo.cantidadContada;
            } else {
                const counted = parseFloat(countedInput);
                if (!isNaN(counted)) {
                    productInfo.cantidadContada = counted; 
                } else {
                    delete productInfo.cantidadContada;
                }
            }
            
            const systemQty = parseFloat(productInfo["Inventario físico"]); 
            const diffElementId = `diff-${productInfo["Código de artículo"] || `item-${productIndex}-${Date.now()}`}-${palletId}`;
            const diffElement = document.getElementById(diffElementId.replace(/[^a-zA-Z0-9-_]/g, '')); 

            if (diffElement) {
                if (productInfo.cantidadContada !== undefined && !isNaN(productInfo.cantidadContada) && !isNaN(systemQty)) {
                    const diff = productInfo.cantidadContada - systemQty;
                    diffElement.textContent = ` Dif: ${InventorySystem.Utils.formatNumber(diff)}`;
                    diffElement.className = 'quantity-diff ' + (diff === 0 ? 'ok' : 'discrepancy');
                } else if (productInfo.cantidadContada !== undefined && !isNaN(productInfo.cantidadContada)) { 
                    diffElement.textContent = ` (Contado: ${InventorySystem.Utils.formatNumber(productInfo.cantidadContada)})`;
                    diffElement.className = 'quantity-diff discrepancy';
                } else {
                    diffElement.textContent = '';
                    diffElement.className = 'quantity-diff';
                }
            }
        }
    }
    
    function updateSessionScannedList() {
        sessionScannedListElement.innerHTML = '';
        if (scannedPalletsSessionData.length > 0) {
            finishSessionButton.classList.remove('hidden');
        } else {
            finishSessionButton.classList.add('hidden');
        }

        scannedPalletsSessionData.forEach(palletInfo => {
            const listItem = document.createElement('li');
            let statusColorClass = 'status-noencontrado';
            let statusTextDisplay = 'NO ENCONTRADO (SISTEMA)';

            if (palletInfo.found) {
                statusColorClass = `status-${(palletInfo.statusSummary || 'mixto').toLowerCase().replace(/\s+/g, '-')}`;
                statusTextDisplay = (palletInfo.statusSummary || 'Mixto').toUpperCase();
            }
            
            listItem.innerHTML = `ID: <span class="highlight">${palletInfo.id}</span> - Estado Sistema: <span class="${statusColorClass}">${statusTextDisplay}</span>`;
            if (palletInfo.found && palletInfo.products && palletInfo.products.length > 0) {
                let itemsConConteo = palletInfo.products.filter(p => p.cantidadContada !== undefined).length;
                listItem.innerHTML += ` (${palletInfo.products.length} tipo(s) prod. sistema / ${itemsConConteo} contado(s))`;
            }
            sessionScannedListElement.appendChild(listItem);
        });
    }

    async function checkPalletId(palletId, fromScan = false) {
        const trimmedPalletId = palletId.trim();
        if (!trimmedPalletId) {
            displayResult('Por favor, ingrese un ID de pallet.', true);
            return;
        }
        
        loadingIndicator.classList.remove('hidden');
        resultDisplay.innerHTML = `<p>Verificando ID: <span class="highlight">${trimmedPalletId}</span>...</p>`;
        if (!fromScan) { 
            palletSummary.innerHTML = '';
        }

        const url = `${APPS_SCRIPT_URL}?idpallet=${encodeURIComponent(trimmedPalletId)}&apiKey=${API_KEY_FOR_SCRIPT}`;
        console.log("checkPalletId - Enviando API Key desde app.js: '" + API_KEY_FOR_SCRIPT + "'");
        console.log("checkPalletId - URL a la que se llamará: " + url);

        try {
            const response = await fetch(url);
            const dataFromServer = await response.json(); 
            loadingIndicator.classList.add('hidden');
            console.log("Respuesta de doGet:", dataFromServer);

            if (dataFromServer.error) {
                displayResult(`Error desde el servidor: ${dataFromServer.error}`, true);
                const palletInfoError = { id: trimmedPalletId, found: false, products: [], statusSummary: "Error Servidor" };
                const existingErrorIndex = scannedPalletsSessionData.findIndex(p => p.id === trimmedPalletId && p.statusSummary === "Error Servidor");
                if (existingErrorIndex === -1) scannedPalletsSessionData.push(palletInfoError);

            } else {
                const palletInfoForSession = {
                    id: dataFromServer.id,
                    found: dataFromServer.found,
                    products: (dataFromServer.products || []).map(p_sistema => ({ 
                        ...p_sistema, 
                        cantidadContada: undefined 
                    })),
                    statusSummary: dataFromServer.statusSummary || (dataFromServer.found ? "Mixto" : "No Encontrado")
                };

                const existingEntryIndex = scannedPalletsSessionData.findIndex(p => p.id === palletInfoForSession.id);
                if (existingEntryIndex > -1) {
                    const existingEntry = scannedPalletsSessionData[existingEntryIndex];
                    palletInfoForSession.products.forEach((newProdInfo, newProdIndex) => {
                        const existingProdInfo = existingEntry.products.find(
                            ep => ep["Código de artículo"] === newProdInfo["Código de artículo"]
                        );
                        if (existingProdInfo && existingProdInfo.cantidadContada !== undefined) {
                            newProdInfo.cantidadContada = existingProdInfo.cantidadContada;
                        }
                    });
                    scannedPalletsSessionData[existingEntryIndex] = palletInfoForSession;
                    displayResult(`Pallet ID: ${palletInfoForSession.id} RE-VERIFICADO. Estado Sistema: ${palletInfoForSession.statusSummary}.`, !palletInfoForSession.found);
                } else {
                    scannedPalletsSessionData.push(palletInfoForSession);
                    displayResult(`Pallet ID: ${palletInfoForSession.id} ${palletInfoForSession.found ? 'ENCONTRADO' : 'NO ENCONTRADO'}. Estado Sistema: ${palletInfoForSession.statusSummary}. Añadido a la sesión.`, !palletInfoForSession.found);
                }
                
                displayPalletSummary(palletInfoForSession);
            }
            updateSessionScannedList();
        } catch (error) {
            console.error('Error al verificar pallet:', error);
            displayResult('Error de conexión o al procesar la solicitud.', true);
            loadingIndicator.classList.add('hidden');
            const palletInfoError = { id: trimmedPalletId, found: false, products: [], statusSummary: "Error Conexión" };
            const existingErrorIndex = scannedPalletsSessionData.findIndex(p => p.id === trimmedPalletId && p.statusSummary === "Error Conexión");
            if (existingErrorIndex === -1) scannedPalletsSessionData.push(palletInfoError);
            updateSessionScannedList();
        }
    }

    // IMPLEMENTACIÓN QUAGGA PARA CÓDIGOS DE BARRAS 1D
    function initQuagga() {
        // Solo iniciar si tenemos un elemento video válido
        if (!video || video.readyState === 0) {
            console.error('Video element not ready');
            return;
        }

        // Configurar Quagga para la detección de códigos de barras
        Quagga.init({
            inputStream: {
                name: "Live",
                type: "LiveStream",
                target: video,
                constraints: {
                    width: 640,
                    height: 480,
                    facingMode: "environment" // Usar cámara trasera en móviles
                },
            },
            locator: {
                patchSize: "medium",
                halfSample: true
            },
            numOfWorkers: navigator.hardwareConcurrency || 4,
            frequency: 10,
            decoder: {
                readers: [
                    // Lista completa de tipos de código de barras soportados
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
                multiple: false // Solo detectar un código a la vez
            },
            locate: true
        }, function(err) {
            if (err) {
                console.error("Error iniciando Quagga:", err);
                displayResult("Error al iniciar el escáner: " + err, true);
                stopScanner();
                return;
            }
            console.log("Quagga iniciado correctamente");
            Quagga.start();
            quaggaScanner = true; // Marcar que Quagga está activo
            
            // Evento para detectar códigos escaneados
            Quagga.onDetected(handleQuaggaDetection);
            
            // Evento para mostrar los resultados de la localización (opcional, para depuración)
            if (canvasElement) {
                Quagga.onProcessed(function(result) {
                    const drawingCtx = canvasContext;
                    if (result) {
                        if (result.boxes) {
                            drawingCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
                            const hasResult = result.boxes.filter(function(box) {
                                return box !== result.box;
                            }).length > 0;
                            
                            if (hasResult) {
                                result.boxes.forEach(function(box) {
                                    drawingCtx.strokeStyle = "green";
                                    drawingCtx.lineWidth = 2;
                                    drawingCtx.strokeRect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
                                });
                            }
                        }
                        
                        if (result.box) {
                            drawingCtx.strokeStyle = "blue";
                            drawingCtx.lineWidth = 2;
                            drawingCtx.strokeRect(
                                result.box.x, result.box.y,
                                result.box.width, result.box.height
                            );
                        }
                        
                        if (result.codeResult && result.codeResult.code) {
                            drawingCtx.font = "24px Arial";
                            drawingCtx.fillStyle = "green";
                            const code = result.codeResult.code;
                            drawingCtx.fillText(code, 10, 50);
                        }
                    }
                });
            }
        });
        
        // Hacer visible el canvas para ver el procesamiento (opcional)
        canvasElement.classList.remove('hidden');
    }

    function handleQuaggaDetection(result) {
        if (result && result.codeResult && result.codeResult.code) {
            const scannedCode = result.codeResult.code;
            console.log("Código detectado:", scannedCode);
            
            // Evitar escanear el mismo código repetidamente
            if (scannedCode !== lastScannedIdForTick) {
                lastScannedIdForTick = scannedCode;
                manualPalletIdInput.value = scannedCode;
                checkPalletId(scannedCode, true);
                
                // Reiniciar el debounce para permitir escanear el mismo código después de un tiempo
                clearTimeout(scanDebounceTimeout);
                scanDebounceTimeout = setTimeout(() => {
                    lastScannedIdForTick = null;
                    resultDisplay.innerHTML = "<p>Listo para el siguiente escaneo...</p>";
                }, 2500);
            }
        }
    }

    function startScanner() {
        palletSummary.innerHTML = ""; 
        resultDisplay.innerHTML = "<p>Iniciando cámara...</p>";

        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
                .then(function(mediaStream) {
                    stream = mediaStream;
                    video.srcObject = mediaStream;
                    video.setAttribute("playsinline", true);
                    video.play();
                    scanning = true;
                    scannerContainer.classList.remove('hidden');
                    startScanButton.classList.add('hidden');
                    stopScanButton.classList.remove('hidden'); 
                    resultDisplay.innerHTML = "<p>Cámara activa. Apunte al código del pallet.</p>";
                    lastScannedIdForTick = null; 
                    
                    // Esperar a que el video esté listo antes de iniciar Quagga
                    video.onloadedmetadata = function() {
                        initQuagga();
                    };
                })
                .catch(function(err) {
                    console.error("Error al acceder a la cámara: ", err);
                    displayResult("Error al acceder a la cámara: " + err.message, true);
                    stopScanner(); 
                });
        } else {
            displayResult("La función de escaneo no es soportada en este navegador.", true);
        }
    }

    function stopScanner() {
        scanning = false;
        
        // Detener Quagga si está activo
        if (quaggaScanner) {
            Quagga.stop();
            quaggaScanner = null;
        }
        
        // Detener stream de video
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
            stream = null;
        }
        
        video.srcObject = null;
        scannerContainer.classList.add('hidden');
        canvasElement.classList.add('hidden'); // Ocultar canvas
        startScanButton.classList.remove('hidden');
        stopScanButton.classList.add('hidden'); 
        clearTimeout(scanDebounceTimeout); 
    }

    async function finishAndProcessSession() {
        if (scannedPalletsSessionData.length === 0) {
            sessionResultDisplay.innerHTML = "<p>No hay pallets escaneados en esta sesión para procesar.</p>";
            return;
        }

        stopScanner(); 
        loadingIndicator.classList.remove('hidden');
        sessionResultDisplay.innerHTML = "<p>Procesando sesión y enviando datos al servidor...</p>";
        console.log("finishAndProcessSession - Enviando API Key desde app.js: '" + API_KEY_FOR_SCRIPT + "'");
        console.log("finishAndProcessSession - Datos de sesión a enviar:", JSON.stringify(scannedPalletsSessionData));
    
        try {
            const response = await fetch(APPS_SCRIPT_URL, {
                method: 'POST',
                body: JSON.stringify({ 
                    apiKey: API_KEY_FOR_SCRIPT,
                    action: 'processSessionWithQuantities',
                    sessionData: scannedPalletsSessionData 
                }),
                redirect: 'follow' 
            });

            if (!response.ok) {
                const errorText = await response.text(); 
                throw new Error(`Error de red del servidor: ${response.status} ${response.statusText}. Respuesta: ${errorText}`);
            }
            
            const result = await response.json(); 
            loadingIndicator.classList.add('hidden');
            console.log("Respuesta de doPost (processSessionWithQuantities):", result);

            if (result.error) {
                sessionResultDisplay.innerHTML = `<p class="error">Error al procesar sesión: ${result.error}</p>`;
            } else if (result.success) {
                let summaryHtml = `<p>Pallets Procesados: ${result.summary.palletsProcesados || 0}</p>
                                   <p>Items Procesados: ${result.summary.itemsProcesados || 0}</p>
                                   <p>Items OK (Conteo = Sistema): ${result.summary.itemsOk || 0}</p>
                                   <p>Items con Discrepancia: ${result.summary.itemsConDiscrepancia || 0}</p>`;
                
                const logSheetUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID_FOR_LOG_LINK}/edit#gid=${LOG_SHEET_GID_FOR_LOG_LINK}`;

                sessionResultDisplay.innerHTML = `<p class="success">${result.message}</p> 
                                                ${summaryHtml}
                                                <p><a href="${logSheetUrl}" target="_blank">Ver Hoja de Resultados del Log</a></p>`; 
                
                scannedPalletsSessionData = [];
                updateSessionScannedList();
                resultDisplay.innerHTML = "<p>Sesión procesada. Puede iniciar una nueva.</p>";
                palletSummary.innerHTML = "";

            } else {
                 sessionResultDisplay.innerHTML = `<p class="error">Respuesta inesperada del servidor al procesar sesión.</p>`;
            }

        } catch (error) {
            console.error('Error al finalizar sesión:', error);
            loadingIndicator.classList.add('hidden');
            sessionResultDisplay.innerHTML = `<p class="error">Error de conexión al finalizar sesión: ${error.message}</p>`;
        }
    }

    // Event Listeners
    startScanButton.addEventListener('click', startScanner);
    stopScanButton.addEventListener('click', stopScanner);
    checkManualButton.addEventListener('click', () => checkPalletId(manualPalletIdInput.value.trim()));
    manualPalletIdInput.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') {
            checkPalletId(manualPalletIdInput.value.trim());
        }
    });
    finishSessionButton.addEventListener('click', finishAndProcessSession);
});