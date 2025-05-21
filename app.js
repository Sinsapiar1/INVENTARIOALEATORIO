document.addEventListener('DOMContentLoaded', () => {
    const startScanButton = document.getElementById('startScanButton');
    const stopScanButton = document.getElementById('stopScanButton');
    const scannerContainer = document.getElementById('scannerContainer');
    const video = document.getElementById('scannerVideo');
    const canvasElement = document.getElementById('scannerCanvas');
    const canvasContext = canvasElement ? canvasElement.getContext('2d') : null;
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

    // Estado de la aplicación
    let scanning = false;
    let stream = null;
    let scannedPalletsSessionData = []; 
    let lastScannedIdForTick = null; 
    let scanDebounceTimeout = null;
    let quaggaScanner = null; // Variable para mantener referencia al escáner
    let isProcessingRequest = false; // Evitar solicitudes simultáneas

    // Sistema de logging para depuración
    const Logger = {
        log: (message, data) => {
            console.log(`[INFO] ${message}`, data || '');
        },
        error: (message, error) => {
            console.error(`[ERROR] ${message}`, error || '');
        },
        warn: (message, data) => {
            console.warn(`[WARN] ${message}`, data || '');
        }
    };

    // Inicializar objeto de utilidades
    if (!window.InventorySystem) window.InventorySystem = {};
    if (!window.InventorySystem.Utils) window.InventorySystem.Utils = {};
    if (!window.InventorySystem.Utils.formatNumber) {
        InventorySystem.Utils.formatNumber = function(num) {
            const parsedNum = parseFloat(num);
            if (isNaN(parsedNum) || num === null || num === undefined || num === '') return 'N/A';
            return Number(parsedNum).toLocaleString('es-ES', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
        };
    }

    // Función para sanitizar los ID y evitar errores con caracteres especiales
    function getSafeId(text) {
        if (!text) return `item-${Date.now()}`;
        // Reemplazar caracteres especiales y espacios con guiones
        return String(text).trim().replace(/[^a-zA-Z0-9-_]/g, '-');
    }

    // Objeto para manejar los modales y funcionalidad de agregar pallets
    const PalletManager = {
        // Referencias DOM para modales
        elements: {
            // Modal agregar pallet
            addPalletModal: document.getElementById('addPalletModal'),
            closeAddPalletModal: document.getElementById('closeAddPalletModal'),
            notFoundPalletId: document.getElementById('notFoundPalletId'),
            newPalletId: document.getElementById('newPalletId'),
            addPalletForm: document.getElementById('addPalletForm'),
            newProductsList: document.getElementById('newProductsList'),
            addProductButton: document.getElementById('addProductButton'),
            cancelAddPallet: document.getElementById('cancelAddPallet'),
            
            // Modal de confirmación
            confirmationModal: document.getElementById('confirmationModal'),
            closeConfirmationModal: document.getElementById('closeConfirmationModal'),
            confirmationTitle: document.getElementById('confirmationTitle'),
            confirmationMessage: document.getElementById('confirmationMessage'),
            cancelConfirmationButton: document.getElementById('cancelConfirmationButton'),
            confirmConfirmationButton: document.getElementById('confirmConfirmationButton')
        },
        
        // Inicializa los eventos y listeners
        init: function() {
            // Inicializar eventos para modal de agregar pallet
            if (this.elements.closeAddPalletModal) {
                this.elements.closeAddPalletModal.addEventListener('click', () => {
                    this.closeModal(this.elements.addPalletModal);
                });
            }
            
            if (this.elements.addPalletForm) {
                this.elements.addPalletForm.addEventListener('submit', (e) => {
                    e.preventDefault();
                    this.handleAddPalletSubmit();
                });
            }
            
            if (this.elements.addProductButton) {
                this.elements.addProductButton.addEventListener('click', () => {
                    this.addProductEntry();
                });
            }
            
            if (this.elements.cancelAddPallet) {
                this.elements.cancelAddPallet.addEventListener('click', () => {
                    this.closeModal(this.elements.addPalletModal);
                });
            }
            
            // Delegar eventos para botones de eliminar producto (ya que son dinámicos)
            if (this.elements.newProductsList) {
                this.elements.newProductsList.addEventListener('click', (e) => {
                    if (e.target.classList.contains('remove-product-btn')) {
                        // Asegurarse de que siempre quede al menos un producto
                        const productEntries = this.elements.newProductsList.querySelectorAll('.product-entry');
                        if (productEntries.length > 1) {
                            e.target.closest('.product-entry').remove();
                        } else {
                            displayResult('Debe haber al menos un producto en el pallet.', true);
                        }
                    }
                });
            }
            
            // Inicializar eventos para modal de confirmación
            if (this.elements.closeConfirmationModal) {
                this.elements.closeConfirmationModal.addEventListener('click', () => {
                    this.closeModal(this.elements.confirmationModal);
                });
            }
            
            if (this.elements.cancelConfirmationButton) {
                this.elements.cancelConfirmationButton.addEventListener('click', () => {
                    this.closeModal(this.elements.confirmationModal);
                });
            }
            
            // Cerrar modales al hacer clic fuera de ellos
            window.addEventListener('click', (e) => {
                if (e.target === this.elements.addPalletModal) {
                    this.closeModal(this.elements.addPalletModal);
                } else if (e.target === this.elements.confirmationModal) {
                    this.closeModal(this.elements.confirmationModal);
                }
            });
            
            // Tecla ESC para cerrar modales
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    this.closeModal(this.elements.addPalletModal);
                    this.closeModal(this.elements.confirmationModal);
                }
            });
            
            Logger.log('PalletManager inicializado');
        },
        
        /**
         * Muestra un modal
         */
        openModal: function(modalElement) {
            if (!modalElement) return;
            
            // Añadir clase para mostrar con animación
            modalElement.classList.add('show');
            
            // Bloquear scroll del body
            document.body.style.overflow = 'hidden';
        },
        
        /**
         * Cierra un modal
         */
        closeModal: function(modalElement) {
            if (!modalElement) return;
            
            // Quitar clase para ocultar con animación
            modalElement.classList.remove('show');
            
            // Restaurar scroll del body
            document.body.style.overflow = '';
        },
        
        /**
         * Muestra el modal para agregar un pallet no encontrado
         */
        showAddPalletModal: function(palletId) {
            // Limpiar formulario anterior
            this.resetAddPalletForm();
            
            // Establecer el ID del pallet
            if (this.elements.notFoundPalletId) {
                this.elements.notFoundPalletId.textContent = palletId;
            }
            if (this.elements.newPalletId) {
                this.elements.newPalletId.value = palletId;
            }
            
            // Mostrar el modal
            this.openModal(this.elements.addPalletModal);
        },
        
        /**
         * Resetea el formulario de agregar pallet
         */
        resetAddPalletForm: function() {
            // Limpiar formulario
            if (this.elements.addPalletForm) {
                this.elements.addPalletForm.reset();
            }
            
            // Resetear lista de productos a uno solo
            if (this.elements.newProductsList) {
                // Guardar el primer producto como plantilla
                const firstProduct = this.elements.newProductsList.querySelector('.product-entry');
                
                // Limpiar todos los productos
                this.elements.newProductsList.innerHTML = '';
                
                // Clonar la plantilla y limpiar sus campos
                if (firstProduct) {
                    const productTemplate = firstProduct.cloneNode(true);
                    const inputs = productTemplate.querySelectorAll('input');
                    inputs.forEach(input => {
                        input.value = '';
                    });
                    
                    // Añadir plantilla limpia
                    this.elements.newProductsList.appendChild(productTemplate);
                }
            }
        },
        
        /**
         * Añade una entrada para un nuevo producto
         */
        addProductEntry: function() {
            if (!this.elements.newProductsList) return;
            
            // Clonar el primer producto como plantilla
            const firstProduct = this.elements.newProductsList.querySelector('.product-entry');
            if (!firstProduct) return;
            
            const newProduct = firstProduct.cloneNode(true);
            
            // Limpiar valores del clon
            const inputs = newProduct.querySelectorAll('input');
            inputs.forEach(input => {
                input.value = '';
            });
            
            // Añadir a la lista
            this.elements.newProductsList.appendChild(newProduct);
            
            // Hacer scroll hasta el nuevo producto
            newProduct.scrollIntoView({ behavior: 'smooth', block: 'center' });
        },
        
        /**
         * Procesa la información del formulario cuando se agrega un pallet
         */
        handleAddPalletSubmit: async function() {
            // Validar formulario (HTML5 tiene required, pero verificamos por si acaso)
            if (!this.validateAddPalletForm()) {
                return;
            }
            
            try {
                // Mostrar indicador de carga
                loadingIndicator.classList.remove('hidden');
                
                // Recopilar datos del formulario
                const formData = this.collectFormData();
                
                // Llamar a la función para guardar en el servidor
                const result = await this.saveNewPallet(formData);
                
                if (result && result.success) {
                    // Mostrar mensaje de éxito
                    displayResult(`Pallet ${formData.palletId} agregado correctamente al inventario.`, false);
                    
                    // Cerrar modal
                    this.closeModal(this.elements.addPalletModal);
                    
                    // Actualizar los datos de la sesión con el nuevo pallet
                    scannedPalletsSessionData.push(formData.palletData);
                    
                    // Actualizar la visualización
                    displayPalletSummary(formData.palletData);
                    updateSessionScannedList();
                } else {
                    throw new Error(result.error || 'Error desconocido al guardar el pallet.');
                }
                
            } catch (error) {
                Logger.error('Error al guardar nuevo pallet', error);
                displayResult(`Error al guardar el pallet: ${error.message}`, true);
            } finally {
                loadingIndicator.classList.add('hidden');
            }
        },
        
        /**
         * Valida el formulario de agregar pallet
         */
        validateAddPalletForm: function() {
            // Verificar que tenemos al menos un producto
            const products = this.elements.newProductsList.querySelectorAll('.product-entry');
            if (products.length === 0) {
                displayResult('Debe agregar al menos un producto al pallet.', true);
                return false;
            }
            
            // Validar campos requeridos (aunque HTML5 ya lo hace con required)
            let isValid = true;
            
            // Verificar que todos los campos requeridos tienen valor
            const requiredInputs = this.elements.addPalletForm.querySelectorAll('[required]');
            requiredInputs.forEach(input => {
                if (!input.value.trim()) {
                    input.classList.add('error');
                    isValid = false;
                } else {
                    input.classList.remove('error');
                }
            });
            
            if (!isValid) {
                displayResult('Complete todos los campos requeridos.', true);
            }
            
            return isValid;
        },
        
        /**
         * Recopila los datos del formulario para crear un nuevo pallet
         */
        collectFormData: function() {
            const palletId = this.elements.newPalletId.value;
            const statusSummary = this.elements.addPalletForm.querySelector('#newPalletStatus').value;
            
            // Recopilar productos
            const products = [];
            const productEntries = this.elements.newProductsList.querySelectorAll('.product-entry');
            
            productEntries.forEach(entry => {
                const product = {
                    "Código de artículo": entry.querySelector('.product-code').value,
                    "Nombre del producto": entry.querySelector('.product-name').value,
                    "Inventario físico": entry.querySelector('.product-quantity').value,
                    "Almacén": entry.querySelector('.product-warehouse').value,
                };
                
                // Campos opcionales
                const disponible = entry.querySelector('.product-available').value;
                if (disponible) {
                    product["Física disponible"] = disponible;
                }
                
                const serial = entry.querySelector('.product-serial').value;
                if (serial) {
                    product["Número de serie"] = serial;
                }
                
                products.push(product);
            });
            
            // Crear objeto de datos del pallet para la sesión
            const palletData = {
                id: palletId,
                found: true,
                products: products,
                statusSummary: statusSummary + ' (Manual)', // Marcar como agregado manualmente
                isManuallyAdded: true // Indicador para saber que fue agregado manualmente
            };
            
            return {
                palletId: palletId,
                statusSummary: statusSummary,
                products: products,
                palletData: palletData
            };
        },
        
        /**
         * Simula guardar un nuevo pallet (sólo en sesión)
         */
        saveNewPallet: async function(formData) {
            try {
                // Simulación de respuesta exitosa (simulamos un retraso de red)
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                return {
                    success: true,
                    message: "Pallet agregado manualmente a la sesión",
                    palletData: formData.palletData
                };
            } catch (error) {
                Logger.error('Error en saveNewPallet', error);
                throw error;
            }
        },
        
        /**
         * Muestra una confirmación para eliminar un pallet
         */
        confirmDeletePallet: function(palletId, callback) {
            // Configurar modal de confirmación
            this.elements.confirmationTitle.textContent = 'Eliminar Pallet';
            this.elements.confirmationMessage.textContent = `¿Está seguro de eliminar el pallet ${palletId} de la sesión?`;
            
            // Configurar botón de confirmación
            this.elements.confirmConfirmationButton.textContent = 'Eliminar';
            this.elements.confirmConfirmationButton.onclick = () => {
                this.closeModal(this.elements.confirmationModal);
                if (typeof callback === 'function') {
                    callback(true);
                }
            };
            
            // Abrir modal
            this.openModal(this.elements.confirmationModal);
        }
    };

    function displayResult(message, isError = false) {
        resultDisplay.innerHTML = `<p class="${isError ? 'error' : 'success'}">${message}</p>`;
    }

    function displayPalletSummary(palletData) {
        palletSummary.innerHTML = ''; 
        
        if (!palletData) {
            palletSummary.innerHTML = '<p>Esperando escaneo o verificación...</p>';
            return;
        }
        
        if (palletData.found && palletData.products && palletData.products.length > 0) {
            let statusColorClass = (palletData.statusSummary || 'mixto').toLowerCase().replace(/\s+/g, '-');
            let html = `<h4>ID Pallet: <span class="highlight">${palletData.id}</span></h4>`;
            html += `<p><strong>Estado General (Sistema):</strong> <span class="status-${statusColorClass}">${(palletData.statusSummary || 'Mixto').toUpperCase()}</span></p>`;
            html += `<p><strong>Productos en Pallet (Sistema): ${palletData.products.length}</strong></p>`;
            html += '<ul>';
            
            palletData.products.forEach((product, index) => {
                // Obtener valores de manera segura para evitar errores
                const systemQuantity = product["Inventario físico"];
                const systemQuantityFormatted = (systemQuantity !== undefined && systemQuantity !== '') 
                    ? InventorySystem.Utils.formatNumber(systemQuantity) 
                    : 'N/A';
                
                // Generar ID seguro para el input - CORREGIDO para evitar error de replace
                const productCode = product["Código de artículo"] 
                    ? getSafeId(product["Código de artículo"]) 
                    : `item-${index}-${Date.now()}`;
                
                const almacen = product["Almacén"] || 'N/A';
                const nombre = product["Nombre del producto"] || 'N/A';
                const codigoArticulo = product["Código de artículo"] || 'N/A';
                const disponible = product["Física disponible"];
                const disponibleFormatted = (disponible !== undefined && disponible !== '') 
                    ? InventorySystem.Utils.formatNumber(disponible) 
                    : 'N/A';
                const numSerie = product["Número de serie"] || '';
                
                html += `<li>
                            <strong>Cód. Artículo:</strong> ${codigoArticulo}<br> 
                            <strong>Nombre:</strong> ${nombre}<br>
                            <strong>Inv. Sist.:</strong> <span class="quantity">${systemQuantityFormatted}</span> | 
                            <strong>Disp. Sist.:</strong> ${disponibleFormatted}<br>
                            <strong>Almacén:</strong> ${almacen}
                            ${numSerie ? `| <strong>Nº Serie:</strong> ${numSerie}` : ''}<br>
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
            
        } else if (palletData.id && palletData.found) {
             palletSummary.innerHTML = `<p>Pallet <span class="highlight">${palletData.id}</span> encontrado, pero sin productos detallados o columnas vacías. Estado: ${palletData.statusSummary || 'Desconocido'}</p>`;
        } else if (palletData.id && !palletData.found) {
             palletSummary.innerHTML = `<p>Pallet <span class="highlight">${palletData.id}</span> NO ENCONTRADO en inventario maestro.</p>`;
        } else {
            palletSummary.innerHTML = '<p>Esperando escaneo o verificación...</p>';
        }
    }

    function attachQuantityChangeListeners() {
        document.querySelectorAll('.counted-quantity-input').forEach(input => {
            input.removeEventListener('input', handleQuantityChange); 
            input.addEventListener('input', handleQuantityChange);
            
            // Optimización para móviles: seleccionar todo al hacer focus
            input.addEventListener('focus', function() {
                this.select();
            });
        });
    }

    function handleQuantityChange(e) {
        const countedInput = e.target.value;
        const palletId = e.target.dataset.palletId;
        const productIndex = parseInt(e.target.dataset.productIndex, 10);

        if (isNaN(productIndex) || !palletId) {
            Logger.error('Datos inválidos en input de cantidad', { palletId, productIndex });
            return;
        }

        const palletSessionEntry = scannedPalletsSessionData.find(p => p.id === palletId);
        if (!palletSessionEntry || !palletSessionEntry.products || !palletSessionEntry.products[productIndex]) {
            Logger.error('No se encontró el producto en la sesión', { palletId, productIndex });
            return;
        }
        
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
        
        // Actualizar diferencia visual con manejo seguro de IDs
        try {
            const systemQty = parseFloat(productInfo["Inventario físico"]); 
            
            // Generar ID del elemento de diferencia de manera segura
            const safeProductCode = productInfo["Código de artículo"] 
                ? getSafeId(productInfo["Código de artículo"])
                : `item-${productIndex}-${Date.now()}`;
            
            const diffElementId = `diff-${safeProductCode}-${palletId}`;
            const diffElement = document.getElementById(diffElementId);

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
        } catch (error) {
            Logger.error('Error al actualizar diferencia visual', error);
        }
        
        updateSessionScannedList();
    }
    
    function updateSessionScannedList() {
        sessionScannedListElement.innerHTML = '';
        
        if (scannedPalletsSessionData.length > 0) {
            finishSessionButton.classList.remove('hidden');
        } else {
            finishSessionButton.classList.add('hidden');
        }

        scannedPalletsSessionData.forEach((palletInfo, index) => {
            const listItem = document.createElement('li');
            let statusColorClass = 'status-noencontrado';
            let statusTextDisplay = 'NO ENCONTRADO (SISTEMA)';

            if (palletInfo.found) {
                statusColorClass = `status-${(palletInfo.statusSummary || 'mixto').toLowerCase().replace(/\s+/g, '-')}`;
                statusTextDisplay = (palletInfo.statusSummary || 'Mixto').toUpperCase();
            }
            
            listItem.innerHTML = `<span class="pallet-index">${index + 1}.</span> ID: <span class="highlight">${palletInfo.id}</span> - Estado Sistema: <span class="${statusColorClass}">${statusTextDisplay}</span>`;
            
            if (palletInfo.found && palletInfo.products && palletInfo.products.length > 0) {
                let itemsConConteo = palletInfo.products.filter(p => p.cantidadContada !== undefined).length;
                listItem.innerHTML += ` <span class="count-progress">(${palletInfo.products.length} tipo(s) prod. sistema / <span class="${itemsConConteo === palletInfo.products.length ? 'count-complete' : 'count-incomplete'}">${itemsConConteo} contado(s)</span>)</span>`;
            }
            
            sessionScannedListElement.appendChild(listItem);
        });
    }

    async function checkPalletId(palletId, fromScan = false) {
        // Normalizar ID del pallet para asegurar búsqueda correcta
        const trimmedPalletId = String(palletId).trim();
        
        if (!trimmedPalletId) {
            displayResult('Por favor, ingrese un ID de pallet.', true);
            return;
        }
        
        // Prevenir peticiones simultáneas
        if (isProcessingRequest) {
            displayResult('Procesando solicitud anterior, espere un momento...', true);
            return;
        }
        
        isProcessingRequest = true;
        
        loadingIndicator.classList.remove('hidden');
        resultDisplay.innerHTML = `<p>Verificando ID: <span class="highlight">${trimmedPalletId}</span>...</p>`;
        
        if (!fromScan) { 
            palletSummary.innerHTML = '';
        }

        // Construir URL con parámetros correctamente codificados
        const url = `${APPS_SCRIPT_URL}?idpallet=${encodeURIComponent(trimmedPalletId)}&apiKey=${encodeURIComponent(API_KEY_FOR_SCRIPT)}`;
        Logger.log("Enviando solicitud", { id: trimmedPalletId });

        try {
            // Configurar timeout para evitar esperas infinitas
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 20000);
            
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);
            
            const dataFromServer = await response.json(); 
            loadingIndicator.classList.add('hidden');
            Logger.log("Respuesta recibida", dataFromServer);

            if (dataFromServer.error) {
                displayResult(`Error desde el servidor: ${dataFromServer.error}`, true);
                const palletInfoError = { 
                    id: trimmedPalletId, 
                    found: false, 
                    products: [], 
                    statusSummary: "Error Servidor" 
                };
                
                const existingErrorIndex = scannedPalletsSessionData.findIndex(
                    p => p.id === trimmedPalletId && p.statusSummary === "Error Servidor"
                );
                
                if (existingErrorIndex === -1) {
                    scannedPalletsSessionData.push(palletInfoError);
                }
            } else {
                // Verificar si el pallet fue encontrado
                if (!dataFromServer.found) {
                    // CAMBIO AQUÍ: Mostrar modal para preguntar si quiere agregar el pallet
                    // Agregar a la sesión como no encontrado para mantener registro
                    const palletInfoNotFound = { 
                        id: trimmedPalletId, 
                        found: false, 
                        products: [], 
                        statusSummary: "No Encontrado" 
                    };
                    
                    const existingNotFoundIndex = scannedPalletsSessionData.findIndex(
                        p => p.id === trimmedPalletId && !p.found
                    );
                    
                    if (existingNotFoundIndex === -1) {
                        scannedPalletsSessionData.push(palletInfoNotFound);
                    }
                    
                    // Mostrar información del pallet no encontrado
                    displayResult(`Pallet ID: ${trimmedPalletId} NO ENCONTRADO en el inventario.`, true);
                    displayPalletSummary(palletInfoNotFound);
                    
                    // Mostrar modal para agregar pallet
                    PalletManager.showAddPalletModal(trimmedPalletId);
                } else {
                    // Procesar respuesta exitosa (pallet encontrado)
                    const palletInfoForSession = {
                        id: dataFromServer.id,
                        found: dataFromServer.found,
                        products: (dataFromServer.products || []).map(p_sistema => ({ 
                            ...p_sistema, 
                            cantidadContada: undefined 
                        })),
                        statusSummary: dataFromServer.statusSummary || (dataFromServer.found ? "Mixto" : "No Encontrado")
                    };

                    // Actualizar o añadir a la sesión
                    const existingEntryIndex = scannedPalletsSessionData.findIndex(p => p.id === palletInfoForSession.id);
                    
                    if (existingEntryIndex > -1) {
                        const existingEntry = scannedPalletsSessionData[existingEntryIndex];
                        
                        // Preservar cantidades contadas
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
            }
            
        } catch (error) {
            Logger.error('Error al verificar pallet', error);
            
            let errorMessage = 'Error de conexión o al procesar la solicitud.';
            if (error.name === 'AbortError') {
                errorMessage = 'La solicitud tardó demasiado. Verifique su conexión e intente nuevamente.';
            }
            
            displayResult(errorMessage, true);
            loadingIndicator.classList.add('hidden');
            
            const palletInfoError = { 
                id: trimmedPalletId, 
                found: false, 
                products: [], 
                statusSummary: "Error Conexión" 
            };
            
            const existingErrorIndex = scannedPalletsSessionData.findIndex(
                p => p.id === trimmedPalletId && p.statusSummary === "Error Conexión"
            );
            
            if (existingErrorIndex === -1) {
                scannedPalletsSessionData.push(palletInfoError);
            }
            
            updateSessionScannedList();
            
        } finally {
            isProcessingRequest = false;
        }
    }

    /**
     * Ajusta la visualización del escáner para que esté correctamente dimensionado
     */
    function adjustScannerLayout() {
        if (!video || !scannerContainer || !canvasElement) return;
        
        // Establecer dimensiones del contenedor
        const containerWidth = Math.min(window.innerWidth - 30, 500);
        scannerContainer.style.width = containerWidth + 'px';
        
        // La altura inicial es auto para mantener la proporción
        scannerContainer.style.height = 'auto';
        
        // Al cargar el video, ajustar altura según proporción
        video.onloadedmetadata = function() {
            if (video.videoWidth && video.videoHeight) {
                const videoRatio = video.videoWidth / video.videoHeight;
                const containerHeight = containerWidth / videoRatio;
                
                scannerContainer.style.height = containerHeight + 'px';
                
                // Ajustar video para llenar el contenedor
                video.style.width = '100%';
                video.style.height = '100%';
                video.style.objectFit = 'cover';
                
                // Ajustar canvas
                canvasElement.width = containerWidth;
                canvasElement.height = containerHeight;
                canvasElement.style.width = '100%';
                canvasElement.style.height = '100%';
                
                Logger.log('Scanner layout adjusted', {
                    containerWidth,
                    containerHeight,
                    videoRatio
                });
            }
        };
    }

    function initQuagga() {
        // Verificar que el video esté listo
        if (!video || video.readyState === 0) {
            Logger.error('Video element not ready');
            return;
        }

        // Ajustar canvas y contenedor antes de iniciar
        if (canvasElement && video.videoWidth && video.videoHeight) {
            canvasElement.width = video.videoWidth;
            canvasElement.height = video.videoHeight;
        }

        // Configuración optimizada de Quagga
        Quagga.init({
            inputStream: {
                name: "Live",
                type: "LiveStream",
                target: video,
                constraints: {
                    width: { min: 640, ideal: 1280, max: 1920 },
                    height: { min: 480, ideal: 720, max: 1080 },
                    aspectRatio: { ideal: 16/9 },
                    facingMode: "environment" 
                },
                area: {
                    top: "20%",    // Restringir área de escaneo
                    right: "10%",
                    left: "10%",
                    bottom: "20%"
                },
            },
            locator: {
                patchSize: "medium",
                halfSample: true
            },
            numOfWorkers: Math.max(2, (navigator.hardwareConcurrency || 4) - 1),
            frequency: 10,
            decoder: {
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
                multiple: false
            },
            locate: true
        }, function(err) {
            if (err) {
                Logger.error("Error iniciando Quagga:", err);
                displayResult("Error al iniciar el escáner: " + err, true);
                stopScanner();
                return;
            }
            
            Logger.log("Quagga iniciado correctamente");
            
            try {
                Quagga.start();
                quaggaScanner = true;
                
                // Evento para detectar códigos
                Quagga.onDetected(handleQuaggaDetection);
                
                // Visualización para depuración
                if (canvasElement && canvasContext) {
                    Quagga.onProcessed(function(result) {
                        if (!result || !canvasContext) return;
                        
                        canvasContext.clearRect(0, 0, canvasElement.width, canvasElement.height);
                        
                        if (result.boxes) {
                            const hasResult = result.boxes.filter(box => box !== result.box).length > 0;
                            
                            if (hasResult) {
                                result.boxes.forEach(function(box) {
                                    canvasContext.strokeStyle = "rgba(0, 255, 0, 0.5)";
                                    canvasContext.lineWidth = 2;
                                    canvasContext.strokeRect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
                                });
                            }
                        }
                        
                        if (result.box) {
                            canvasContext.strokeStyle = "rgba(0, 0, 255, 0.8)";
                            canvasContext.lineWidth = 2;
                            canvasContext.strokeRect(
                                result.box.x, result.box.y,
                                result.box.width, result.box.height
                            );
                        }
                        
                        if (result.codeResult && result.codeResult.code) {
                            canvasContext.font = "16px Arial";
                            canvasContext.fillStyle = "#00cc00";
                            canvasContext.fillRect(0, 0, 220, 30);
                            canvasContext.fillStyle = "#000000";
                            canvasContext.fillText(`Código: ${result.codeResult.code}`, 10, 20);
                        }
                    });
                }
                
                canvasElement.classList.remove('hidden');
                displayResult("Escáner activo. Apunte al código del pallet.", false);
                
            } catch (startError) {
                Logger.error("Error al iniciar Quagga.start()", startError);
                displayResult("Error al iniciar el escáner. Intente de nuevo.", true);
                stopScanner();
            }
        });
    }

    function handleQuaggaDetection(result) {
        if (!result || !result.codeResult || !result.codeResult.code) return;
        
        const scannedCode = result.codeResult.code;
        Logger.log("Código detectado", scannedCode);
        
        // Prevenir escaneos repetidos del mismo código
        if (scannedCode !== lastScannedIdForTick) {
            lastScannedIdForTick = scannedCode;
            
            // Actualizar UI y procesar
            manualPalletIdInput.value = scannedCode;
            checkPalletId(scannedCode, true);
            
            // Reiniciar debounce
            clearTimeout(scanDebounceTimeout);
            scanDebounceTimeout = setTimeout(() => {
                lastScannedIdForTick = null;
                resultDisplay.innerHTML = "<p>Listo para el siguiente escaneo...</p>";
            }, 2500);
        }
    }

    function startScanner() {
        palletSummary.innerHTML = ""; 
        resultDisplay.innerHTML = "<p>Iniciando cámara...</p>";

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            displayResult("La función de escaneo no es soportada en este navegador.", true);
            return;
        }

        navigator.mediaDevices.getUserMedia({ 
            video: { 
                facingMode: "environment",
                width: { ideal: 1280, min: 640 },
                height: { ideal: 720, min: 480 },
                aspectRatio: { ideal: 16/9 }
            } 
        }).then(function(mediaStream) {
            stream = mediaStream;
            video.srcObject = mediaStream;
            video.setAttribute("playsinline", true);
            video.play();
            
            scanning = true;
            
            // Mostrar contenedor del escáner
            scannerContainer.classList.remove('hidden');
            startScanButton.classList.add('hidden');
            stopScanButton.classList.remove('hidden'); 
            
            resultDisplay.innerHTML = "<p>Cámara activa. Apunte al código del pallet.</p>";
            lastScannedIdForTick = null; 
            
            // Ajustar layout antes de iniciar
            adjustScannerLayout();
            
            // Iniciar después de cargar metadatos
            video.onloadedmetadata = function() {
                // Ajustar nuevamente y iniciar Quagga
                adjustScannerLayout();
                
                // Dar tiempo para que se apliquen los ajustes
                setTimeout(() => {
                    initQuagga();
                }, 300);
            };
            
        }).catch(function(err) {
            Logger.error("Error al acceder a la cámara", err);
            
            let errorMsg = "Error al acceder a la cámara";
            if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                errorMsg = "Permiso de cámara denegado. Por favor, permita el acceso a la cámara.";
            } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
                errorMsg = "No se encontró ninguna cámara en este dispositivo.";
            }
            
            displayResult(errorMsg, true);
            stopScanner();
        });
    }

    function stopScanner() {
        Logger.log("Intentando detener el escáner...");
        
        try {
            // Indicar que no estamos escaneando
            scanning = false;
            
            // Detener Quagga primero
            if (quaggaScanner && typeof Quagga !== 'undefined') {
                try {
                    // Eliminar event listeners para evitar llamadas residuales
                    Quagga.offDetected(handleQuaggaDetection);
                    Logger.log("Event listeners de Quagga eliminados");
                } catch (listenerError) {
                    Logger.warn("Error al eliminar listeners de Quagga", listenerError);
                }
                
                try {
                    Quagga.stop();
                    Logger.log("Quagga detenido correctamente");
                } catch (stopError) {
                    Logger.error("Error al detener Quagga", stopError);
                }
                
                quaggaScanner = null;
            }
            
            // Luego detener el stream de video
            if (stream) {
                try {
                    const tracks = stream.getTracks();
                    tracks.forEach(track => {
                        track.stop();
                        Logger.log(`Track de tipo ${track.kind} detenido`);
                    });
                } catch (trackError) {
                    Logger.error("Error al detener tracks de video", trackError);
                }
                stream = null;
            }
            
            // Limpiar la UI
            if (video) {
                video.srcObject = null;
                video.onloadedmetadata = null;
            }
            
            scannerContainer.classList.add('hidden');
            if (canvasElement) canvasElement.classList.add('hidden');
            startScanButton.classList.remove('hidden');
            stopScanButton.classList.add('hidden'); 
            
            // Limpiar timeouts
            clearTimeout(scanDebounceTimeout);
            
            Logger.log("Escáner detenido completamente");
            
        } catch (error) {
            // Manejo de errores durante la detención
            Logger.error("Error general al detener el escáner", error);
            
            // Fuerza una limpieza de emergencia
            try {
                if (video) video.srcObject = null;
                scannerContainer.classList.add('hidden');
                if (canvasElement) canvasElement.classList.add('hidden');
                startScanButton.classList.remove('hidden');
                stopScanButton.classList.add('hidden');
                
                scanning = false;
                quaggaScanner = null;
                stream = null;
                
                Logger.warn("Se forzó la detención del escáner tras un error");
                
            } catch (e) {
                // Error crítico - último recurso
                Logger.error("Error crítico durante limpieza de emergencia", e);
                alert("Error crítico. Por favor, recargue la página.");
            }
        }
    }

    async function finishAndProcessSession() {
        if (scannedPalletsSessionData.length === 0) {
            sessionResultDisplay.innerHTML = "<p>No hay pallets escaneados en esta sesión para procesar.</p>";
            return;
        }

        // Detener el escáner si está activo
        if (scanning) {
            stopScanner();
        }
        
        // Mostrar carga
        loadingIndicator.classList.remove('hidden');
        sessionResultDisplay.innerHTML = "<p>Procesando sesión y enviando datos al servidor...</p>";
        Logger.log("Iniciando procesamiento de sesión", { pallets: scannedPalletsSessionData.length });
    
        try {
            // Verificar conexión
            if (!navigator.onLine) {
                throw new Error("No hay conexión a internet. Verifique su conexión e intente nuevamente.");
            }
            
            // Configurar timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000);
            
            // Enviar datos
            const response = await fetch(APPS_SCRIPT_URL, {
                method: 'POST',
                body: JSON.stringify({ 
                    apiKey: API_KEY_FOR_SCRIPT,
                    action: 'processSessionWithQuantities',
                    sessionData: scannedPalletsSessionData 
                }),
                signal: controller.signal,
                redirect: 'follow' 
            });
            
            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text(); 
                throw new Error(`Error de servidor: ${response.status} ${response.statusText}. Respuesta: ${errorText}`);
            }
            
            const result = await response.json(); 
            loadingIndicator.classList.add('hidden');
            Logger.log("Respuesta de procesamiento de sesión", result);

            if (result.error) {
                sessionResultDisplay.innerHTML = `<p class="error">Error al procesar sesión: ${result.error}</p>`;
            } else if (result.success) {
                // Generar resumen
                let summaryHtml = `<p>Pallets Procesados: ${result.summary.palletsProcesados || 0}</p>
                                   <p>Items Procesados: ${result.summary.itemsProcesados || 0}</p>
                                   <p>Items OK (Conteo = Sistema): ${result.summary.itemsOk || 0}</p>
                                   <p>Items con Discrepancia: ${result.summary.itemsConDiscrepancia || 0}</p>`;
                
                const logSheetUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID_FOR_LOG_LINK}/edit#gid=${LOG_SHEET_GID_FOR_LOG_LINK}`;

                sessionResultDisplay.innerHTML = `<p class="success">${result.message}</p> 
                                                ${summaryHtml}
                                                <p><a href="${logSheetUrl}" target="_blank">Ver Hoja de Resultados del Log</a></p>`;
                
                // Limpiar datos
                scannedPalletsSessionData = [];
                updateSessionScannedList();
                resultDisplay.innerHTML = "<p>Sesión procesada. Puede iniciar una nueva.</p>";
                palletSummary.innerHTML = "";
            } else {
                 sessionResultDisplay.innerHTML = `<p class="error">Respuesta inesperada del servidor al procesar sesión.</p>`;
            }

        } catch (error) {
            Logger.error('Error al finalizar sesión', error);
            loadingIndicator.classList.add('hidden');
            
            let errorMessage = error.message;
            if (error.name === 'AbortError') {
                errorMessage = "La solicitud tomó demasiado tiempo. El servidor podría estar ocupado.";
            }
            
            sessionResultDisplay.innerHTML = `<p class="error">Error de conexión al finalizar sesión: ${errorMessage}</p>`;
        }
    }

    // Event Listeners mejorados
    startScanButton.addEventListener('click', function(e) {
        e.preventDefault();
        if (scanning) return; // Prevenir inicios múltiples
        startScanner();
    });
    
    stopScanButton.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        
        // Desactivar el botón temporalmente para evitar clics múltiples
        stopScanButton.disabled = true;
        stopScanner();
        
        // Reactivar después de un breve retraso
        setTimeout(() => {
            stopScanButton.disabled = false;
        }, 1000);
    });
    
    checkManualButton.addEventListener('click', () => {
        checkPalletId(manualPalletIdInput.value.trim());
    });
    
    manualPalletIdInput.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            checkPalletId(manualPalletIdInput.value.trim());
        }
    });
    
    finishSessionButton.addEventListener('click', finishAndProcessSession);
    
    // Ajuste del escáner al cambiar tamaño de ventana
    window.addEventListener('resize', function() {
        if (scanning) {
            adjustScannerLayout();
        }
    });
    
    // Detectar cambios de orientación
    window.addEventListener('orientationchange', function() {
        if (scanning) {
            setTimeout(adjustScannerLayout, 500);
        }
    });
    
    // Manejar tecla Escape para detener escáner
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && scanning) {
            stopScanner();
        }
    });
    
    // Detener escáner si la página no está visible
    document.addEventListener('visibilitychange', function() {
        if (document.hidden && scanning) {
            stopScanner();
        }
    });
    
    // Inicializar PalletManager
    PalletManager.init();
    
    Logger.log("Aplicación inicializada correctamente");
});
