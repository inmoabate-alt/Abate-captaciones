# Abate · Captaciones Pocitos

Prototipo de extensión local para Chrome o Microsoft Edge de escritorio. Organiza avisos de Mercado Libre para la campaña de captación en Pocitos, Montevideo, usando las páginas que la sesión del navegador permita consultar. No envía mensajes de WhatsApp.

## Descargar e instalar

En GitHub, abrí `abate-pocitos.zip` y usá **Download raw file** para descargar el paquete de instalación. También podés elegir **Code → Download ZIP** para descargar todo el repositorio y usar directamente la carpeta `extension`.

1. Descomprimí el paquete de instalación.
2. Abrí `chrome://extensions` o `edge://extensions`.
3. Activá **Modo desarrollador** y elegí **Cargar descomprimida**.
4. Seleccioná la carpeta que contiene `manifest.json`.
5. Abrí la búsqueda de dueño vende en Pocitos con tu sesión iniciada y pulsá el icono de Abate para empezar.

La primera prueba limita el recorrido a 25 avisos y 10 páginas de resultados, con límites configurables. Los casos sin ubicación o condición de dueño directo confirmables quedan para revisión. Los avisos que rechacen inmobiliarias quedan excluidos.

## Validación y límites

Pasaron 34 pruebas con páginas y respuestas sintéticas; una prueba de integración de la extensión instalada quedó omitida porque la política administrada del navegador del entorno impide instalar extensiones locales. No se alteró esa política.

El funcionamiento con avisos reales de Mercado Libre todavía no se comprobó. Los selectores y permisos del sitio pueden requerir ajustes tras la primera prueba autorizada en un navegador con acceso. No se garantiza encontrar todos los avisos ni que todos permitan ver el teléfono.

La herramienta no pide contraseñas, no exporta cookies, no envía la base a un servidor y no habilita contactos automáticamente para campañas comerciales.

Más instrucciones en [extension/LEEME.md](extension/LEEME.md). El código está en `extension/` y las pruebas en `extension/tests/`.
