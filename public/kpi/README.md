# Medallas de KPI (home del admin K-BROS)

Acá van las piezas gráficas de las medallas del carrusel de KPIs de la home.

## Cómo cargarlas
1. Subí **una sola imagen por KPI** a esta carpeta (`public/kpi/`).
2. Proporción **vertical tipo carta** (~5:7). Recomendado: 300×420 px, PNG o WebP con fondo transparente.
3. **Una sola versión a color** por medalla. El estado *pendiente / en progreso* se pinta en gris
   automáticamente por CSS (filtro grayscale). No subas una versión gris aparte.

## Nombres esperados (según `KPI_CONFIG` en `admin-views/admin.html`)
| KPI                 | archivo         |
|---------------------|-----------------|
| Ventas del período  | `ventas.png`    |
| Litros vendidos     | `litros.png`    |
| Clientes nuevos     | `clientes.png`  |
| Ticket promedio     | `ticket.png`    |
| OEE producción      | `oee.png`       |
| Satisfacción        | `nps.png`       |

Mientras el archivo no exista, la medalla muestra un placeholder con el nombre del archivo.

## Editar los KPIs (nombre, meta, valor, estado)
La lista vive en `admin-views/admin.html`, constante `KPI_CONFIG` (buscá "EDITABLE POR EL EQUIPO").
- `meta` / `actual` en `null` = manual (lo completás vos). No se inventan valores.
- `auto:'ventaTotal'` o `auto:'litros'` = se llena solo con el dato real del período.
