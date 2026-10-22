# Abate · Captaciones Pocitos

Prototipo local para Chrome y Microsoft Edge de escritorio. Trabaja en el navegador donde ya tenés iniciada tu sesión de Mercado Libre. Organiza avisos para revisar; no envía consultas ni mensajes de WhatsApp.

## Instalar una vez

1. Descomprimí el ZIP en una carpeta que puedas conservar.
2. En Chrome abrí `chrome://extensions`; en Edge, `edge://extensions`.
3. Activá **Modo desarrollador**.
4. Elegí **Cargar descomprimida** y seleccioná la carpeta que contiene `manifest.json`.
5. Abrí Mercado Libre normalmente, iniciá sesión y buscá propiedades en venta en **Montevideo → Pocitos**, usando «dueño vende». Podés usar una búsqueda que ya tengas abierta.

No compartas tu contraseña ni exportes tu sesión: la extensión usa las páginas que abre tu propio navegador. Desde este chat no se controla tu computadora.

## Preparar la base

1. Con la búsqueda abierta, pulsá el icono de la extensión **Abate · Captaciones Pocitos**. Si no aparece, buscá la extensión en el menú de extensiones del navegador.
2. En el panel, comprobá la pestaña de origen y el límite de avisos. La primera prueba está limitada a **25 avisos y 10 páginas de búsqueda**; ambos límites están visibles y se pueden cambiar.
3. Pulsá **Empezar**. Se abrirá una pestaña de trabajo que recorrerá los avisos y las siguientes páginas de resultados que el sitio permita consultar. Conservá abierto el navegador.
4. Revisá los resultados y descargá el CSV. Podés pausarlo desde el panel. No se realiza ningún envío.

La opción de mostrar teléfonos permite pulsar únicamente un botón visible llamado «Ver teléfono» o «Mostrar teléfono». Si se necesita iniciar sesión, completar un formulario, aceptar una autorización adicional o resolver una verificación, la extensión no lo hace automáticamente. El dato puede quedar pendiente o el recorrido pausarse.

## Qué revisa

- Ubicación en **Pocitos, Montevideo**, a partir de la ubicación y las rutas de navegación del aviso. Una mención a Pocitos dentro de una descripción no confirma que la propiedad esté allí. **Pocitos Nuevo se mantiene separado**.
- Indicios expresos de venta por dueño directo. Un texto que dice «dueño vende» es un indicio, no una comprobación de identidad o titularidad.
- Rechazos a inmobiliarias: por ejemplo, «no inmobiliarias» o «abstenerse inmobiliarias».
- Avisos repetidos, según su identificador.
- Teléfonos visibles y disponibles normalmente en la sesión, cuando el formato permite reconocerlos.

Los casos inciertos se guardan para revisión y no se presentan como contactos confirmados. Los teléfonos no se habilitan automáticamente para una campaña: el CSV registra por separado que no consta autorización para contacto comercial.

## Datos y permisos

La extensión solicita acceso a páginas HTTPS de `mercadolibre.com.uy`, ejecución de su lector en esas páginas y almacenamiento local. La pestaña activa permite identificar la búsqueda que elegís. No solicita permiso para leer cookies ni para enviar mensajes. No tiene un servidor ni envía la base a Abate o a este chat.

La base queda en el almacenamiento local de la extensión dentro del perfil del navegador. Podés descargarla y borrarla desde el panel. Al desinstalar la extensión se elimina su almacenamiento; conservá antes los CSV que necesites.

## Estado de validación

Se valida el lector de páginas, los controles y el recorrido con páginas y respuestas sintéticas locales. El navegador administrado de este entorno bloquea la instalación de extensiones locales; por eso la prueba de integración de la extensión instalada queda sin ejecutar. No se modificó esa política.

**No se comprobó su funcionamiento contra avisos reales de Mercado Libre**, porque el entorno de este chat no consiguió abrirlos. Los selectores del sitio, la disponibilidad de teléfonos, el acceso a páginas sucesivas y los límites de consulta pueden variar. La primera ejecución en tu navegador es una prueba funcional, no una garantía de recolectar todos los avisos de Pocitos.

La extensión se detiene ante restricciones reconocibles y no intenta eludir verificaciones ni utilizar API privadas. Usala únicamente para las consultas y el uso de datos que estén permitidos para tu cuenta.

El envío por WhatsApp requiere una integración y una validación aparte. Esta herramienta solo prepara una planilla de oportunidades.

## Verificación del prototipo

Los archivos `tests/` se entregan por separado del ZIP de instalación. Requieren Node.js y Playwright con Chromium. No son necesarios para instalar ni usar la extensión.

Resultado de esta versión: **34 pruebas pasaron; 1 prueba de integración quedó omitida por la política administrada que impide instalar extensiones en este entorno**. Las pruebas ejecutadas usan páginas y respuestas simuladas; no representan una consulta a Mercado Libre real.
