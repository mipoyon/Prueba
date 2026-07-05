// Módulo para cargar mapas como IMAGEN + canvas y proporcionar navegación raster

class MapLoader {
    constructor() {
        this.currentMap = null;
        this.img = document.getElementById('map-image');
        this.canvas = document.getElementById('map-canvas');
        this.ctx = this.canvas ? this.canvas.getContext('2d') : null;

        this.grid = [];
        this.TILE = 4; // tamaño de celda

        if (!this.img || !this.canvas) {
            console.error('No se encontraron los elementos de imagen/canvas del mapa (#map-image, #map-canvas)');
        }
    }

    /**
     * Carga una imagen de mapa (PNG/SVG) y escanea píxeles para navegación
     * @param {string} mapPath
     * @returns {Promise<boolean>}
     */
    async loadMap(mapPath) {
        return new Promise((resolve) => {
            if (!this.img || !this.canvas) {
                resolve(false);
                return;
            }

            this.img.onload = () => {
                // Ajustar canvas al tamaño natural de la imagen
                this.canvas.width = this.img.naturalWidth || this.img.width || 800;
                this.canvas.height = this.img.naturalHeight || this.img.height || 600;

                // Escanear para generar la grid de navegación
                this.scanMap();

                this.currentMap = mapPath;
                resolve(true);
            };

            this.img.onerror = (e) => {
                console.error('Error cargando imagen de mapa:', e);
                resolve(false);
            };

            // Iniciar carga
            this.img.src = mapPath;
        });
    }

    /**
     * Escanea la imagen y construye la malla (grid) para navegación
     */
    scanMap() {
        if (!this.img || !this.canvas) return;

        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d');
        tempCanvas.width = this.canvas.width;
        tempCanvas.height = this.canvas.height;
        tempCtx.drawImage(this.img, 0, 0, tempCanvas.width, tempCanvas.height);

        const imgData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height).data;
        const cols = Math.floor(tempCanvas.width / this.TILE);
        const rows = Math.floor(tempCanvas.height / this.TILE);

        this.grid = Array(cols).fill().map(() => Array(rows).fill(0));

        // PASO 1: Detección estricta de paredes finas
        for (let x = 0; x < cols; x++) {
            for (let y = 0; y < rows; y++) {
                let esPared = false;
                const puntos = [{ ox: .2, oy: .2 }, { ox: .8, oy: .2 }, { ox: .2, oy: .8 }, { ox: .8, oy: .8 }, { ox: .5, oy: .5 }];

                for (let p of puntos) {
                    const pxX = Math.floor(x * this.TILE + this.TILE * p.ox);
                    const pxY = Math.floor(y * this.TILE + this.TILE * p.oy);
                    const i = (pxY * tempCanvas.width + pxX) * 4;
                    if (imgData[i + 3] > 50 && (imgData[i] + imgData[i + 1] + imgData[i + 2]) / 3 < 160) {
                        esPared = true; break;
                    }
                }
                if (esPared) this.grid[x][y] = 999;
            }
        }

        // PASO 2: Campo de fuerza
        const RADIO = 4;
        for (let x = 0; x < cols; x++) {
            for (let y = 0; y < rows; y++) {
                if (this.grid[x][y] === 999) continue;
                let costoExtra = 0;
                for (let dx = -RADIO; dx <= RADIO; dx++) {
                    for (let dy = -RADIO; dy <= RADIO; dy++) {
                        const nx = x + dx, ny = y + dy;
                        if (nx >= 0 && nx < cols && ny >= 0 && ny < rows && this.grid[nx][ny] === 999) {
                            const dist = Math.sqrt(dx * dx + dy * dy);
                            if (dist <= RADIO) {
                                costoExtra = Math.max(costoExtra, (RADIO + 1 - dist) * 20);
                            }
                        }
                    }
                }
                this.grid[x][y] = costoExtra;
            }
        }
    }

    /**
     * Calcula ruta entre dos puntos en coordenadas del mapa.
     * coords pueden ser [x,y] en pixeles o [xNorm,yNorm] (0..1)
     */
    drawRouteFromCoords(coordsA, coordsB) {
        if (!this.ctx || !this.canvas) return false;

        // Limpiar inmediatamente animación y canvas previo
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
        }
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        if (!coordsA || !coordsB || !this.grid) return false;

        const toPixel = (c) => {
            let x = c[0]; let y = c[1];
            if (x <= 1 && y <= 1) {
                // Normalizado
                x = Math.round(x * this.canvas.width);
                y = Math.round(y * this.canvas.height);
            }
            return { x: Math.round(x), y: Math.round(y) };
        };

        const aPix = toPixel(coordsA);
        const bPix = toPixel(coordsB);

        const start = { x: Math.floor(aPix.x / this.TILE), y: Math.floor(aPix.y / this.TILE) };
        const end = { x: Math.floor(bPix.x / this.TILE), y: Math.floor(bPix.y / this.TILE) };

        console.time('A* Pathfinding');
        const path = this.aStar(start, end);
        console.timeEnd('A* Pathfinding');
        if (path) {
            this.drawPath(path);
            return true;
        }

        console.warn('No se encontró camino entre puntos dados');
        return false;
    }

    aStar(start, end) {
        const cols = this.grid.length;
        const rows = this.grid[0].length;
        const size = cols * rows;

        const startIdx = start.x + start.y * cols;
        const endIdx = end.x + end.y * cols;

        const gScore = new Float32Array(size);
        const fScore = new Float32Array(size);
        gScore.fill(Infinity);
        fScore.fill(Infinity);

        const cameFrom = new Int32Array(size);
        cameFrom.fill(-1);

        // States: 0 = unvisited, 1 = in openSet, 2 = closed
        const nodeState = new Uint8Array(size);

        gScore[startIdx] = 0;
        fScore[startIdx] = Math.sqrt((start.x - end.x) * (start.x - end.x) + (start.y - end.y) * (start.y - end.y));

        const heap = [];
        // Helper functions for binary heap
        const heapPush = (idx) => {
            heap.push(idx);
            let i = heap.length - 1;
            while (i > 0) {
                const p = (i - 1) >> 1;
                if (fScore[heap[i]] < fScore[heap[p]]) {
                    const tmp = heap[i];
                    heap[i] = heap[p];
                    heap[p] = tmp;
                    i = p;
                } else {
                    break;
                }
            }
        };

        const heapPop = () => {
            if (heap.length === 0) return -1;
            const top = heap[0];
            const bottom = heap.pop();
            if (heap.length > 0) {
                heap[0] = bottom;
                let i = 0;
                const len = heap.length;
                while ((i << 1) + 1 < len) {
                    let left = (i << 1) + 1;
                    let right = left + 1;
                    let best = i;
                    if (fScore[heap[left]] < fScore[heap[best]]) {
                        best = left;
                    }
                    if (right < len && fScore[heap[right]] < fScore[heap[best]]) {
                        best = right;
                    }
                    if (best !== i) {
                        const tmp = heap[i];
                        heap[i] = heap[best];
                        heap[best] = tmp;
                        i = best;
                    } else {
                        break;
                    }
                }
            }
            return top;
        };

        heapPush(startIdx);
        nodeState[startIdx] = 1;

        while (heap.length > 0) {
            const currentIdx = heapPop();
            if (currentIdx === -1) break;

            // If it's already in the closed set, we skip it (lazy update)
            if (nodeState[currentIdx] === 2) continue;

            const curX = currentIdx % cols;
            const curY = Math.floor(currentIdx / cols);

            if (curX === end.x && curY === end.y) {
                // Reconstruct path
                const path = [];
                let tempIdx = currentIdx;
                while (tempIdx !== -1) {
                    const tx = tempIdx % cols;
                    const ty = Math.floor(tempIdx / cols);
                    path.push({ x: tx, y: ty });
                    tempIdx = cameFrom[tempIdx];
                }
                return path;
            }

            nodeState[currentIdx] = 2; // Mark as closed

            // Neighbors: 8-directions
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    if (dx === 0 && dy === 0) continue;

                    const vx = curX + dx;
                    const vy = curY + dy;

                    if (vx < 0 || vx >= cols || vy < 0 || vy >= rows) continue;

                    const vIdx = vx + vy * cols;

                    // If it's in the closed set, we don't need to check it
                    if (nodeState[vIdx] === 2) continue;

                    const cost = this.grid[vx][vy];
                    if (cost === 999) continue;

                    // Strict corner blocking
                    if (dx !== 0 && dy !== 0) {
                        if (this.grid[curX][vy] === 999 || this.grid[vx][curY] === 999) continue;
                    }

                    const distWeight = (dx !== 0 && dy !== 0) ? 1.41421356 : 1.0;
                    const tentativeG = gScore[currentIdx] + distWeight + cost;

                    if (tentativeG < gScore[vIdx]) {
                        cameFrom[vIdx] = currentIdx;
                        gScore[vIdx] = tentativeG;
                        fScore[vIdx] = tentativeG + Math.sqrt((vx - end.x) * (vx - end.x) + (vy - end.y) * (vy - end.y));

                        nodeState[vIdx] = 1;
                        heapPush(vIdx);
                    }
                }
            }
        }
        return null;
    }

    /**
     * Dibuja la ruta (render) en el canvas de overlay
     */
    /**
     * Dibuja la ruta (render) en el canvas de overlay con ANIMACIÓN
     */
    drawPath(path) {
        if (!path || path.length < 2 || !this.ctx) return;

        // Limpiar animación previa si existe
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
        }

        const pDestino = path[0];
        const indexReferencia = Math.min(path.length - 1, 4);
        const pReferencia = path[indexReferencia];

        const xDestino = pDestino.x * this.TILE + this.TILE / 2;
        const yDestino = pDestino.y * this.TILE + this.TILE / 2;
        const xRef = pReferencia.x * this.TILE + this.TILE / 2;
        const yRef = pReferencia.y * this.TILE + this.TILE / 2;
        const angulo = Math.atan2(yDestino - yRef, xDestino - xRef);

        let offset = 0;

        const animate = () => {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

            // Dibujar Línea
            this.ctx.beginPath();
            this.ctx.strokeStyle = "#d32f2f";
            this.ctx.lineWidth = 5;
            this.ctx.lineCap = "round";
            this.ctx.setLineDash([10, 10]);
            this.ctx.lineDashOffset = -offset; // Movimiento

            this.ctx.moveTo(path[path.length - 1].x * this.TILE + this.TILE / 2, path[path.length - 1].y * this.TILE + this.TILE / 2);
            for (let i = path.length - 2; i >= indexReferencia; i--) {
                this.ctx.lineTo(path[i].x * this.TILE + this.TILE / 2, path[i].y * this.TILE + this.TILE / 2);
            }
            this.ctx.stroke();

            // Dibujar Flecha
            this.ctx.setLineDash([]);
            this.ctx.fillStyle = "#d32f2f";
            this.ctx.save();
            this.ctx.translate(xDestino, yDestino);
            this.ctx.rotate(angulo);
            this.ctx.beginPath();
            this.ctx.moveTo(0, 0);
            this.ctx.lineTo(-18, -10);
            this.ctx.lineTo(-18, 10);
            this.ctx.closePath();
            this.ctx.fill();
            this.ctx.restore();

            // Actualizar offset
            offset += 0.5;
            if (offset > 20) offset = 0;

            this.animationFrameId = requestAnimationFrame(animate);
        };

        animate();
    }

    getCurrentMap() {
        return this.img;
    }

    getCurrentMapPath() {
        return this.currentMap;
    }
}

export default MapLoader;
