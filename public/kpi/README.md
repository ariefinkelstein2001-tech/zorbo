# Medallas de KPI (home del admin K-BROS)

Piezas gráficas de las medallas del carrusel de KPIs de la home. Cada arte YA trae
su nombre y su meta; el carrusel muestra la imagen + estado + progreso debajo.

## Archivos (ya cargados)
`KPI1.png` … `KPI15.png` — proporción vertical tipo carta (~5:7). Una sola versión a color;
el estado *en progreso* se pinta en gris automáticamente por CSS.

## Mapeo actual (constante `KPI_CONFIG` en `admin-views/admin.html`)
| Archivo    | KPI                                   | Meta          | Fuente        |
|------------|---------------------------------------|---------------|---------------|
| KPI1.png   | Venta mensual                         | $200.000.000  | **auto** (venta real del período) |
| KPI2.png   | +10K seguidores IG · Kairos Garden    | >10.000       | manual        |
| KPI3.png   | Merma de cerveza                      | <1%           | manual        |
| KPI4.png   | EBITDA general                        | 20%           | manual        |
| KPI5.png   | EBITDA · Kairos Garden                | 15%           | manual        |
| KPI6.png   | EBITDA · Kairos Badass                | 15%           | manual        |
| KPI7.png   | EBITDA cervecería                     | 15%           | manual        |
| KPI8.png   | +10K seguidores IG · Kairos Badass    | >10.000       | manual        |
| KPI9.png   | +10K seguidores IG · Firulais         | >10.000       | manual        |
| KPI10.png  | Venta mensual                         | $100.000.000  | **auto** (venta real del período) |
| KPI11.png  | 5 medallas de bronce                  | logro         | manual        |
| KPI12.png  | 5 medallas de plata                   | logro         | manual        |
| KPI13.png  | 5 medallas de oro                     | logro         | manual        |
| KPI14.png  | Costo prom. ponderado A&B · Badass    | ≤30%          | manual        |
| KPI15.png  | Costo prom. ponderado A&B · Garden    | ≤25%          | manual        |

## Editar
En `admin-views/admin.html`, constante `KPI_CONFIG` ("EDITABLE POR EL EQUIPO"):
- `meta` numérica → se usa para calcular estado (cumplido / en progreso). `null` = medalla de logro.
- `actual` → dejalo en `null` hasta tener el dato (no se inventan valores).
- `auto:'ventaTotal'` = se llena solo con la venta real del período.
- `metaDir:'lte'` = la meta es un techo (mejor si es menor: merma, costos).
