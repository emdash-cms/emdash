# Plan de preparación del ecommerce para producción

**Estado** — Implementado en código. El envío se verifica con el proveedor local en pruebas. La entrega real de Resend queda para la prueba Cloudflare en la nube. Aplica a los templates Node y Cloudflare y al código de tienda que comparten en EmDash. La [especificación funcional](shop-functional-spec.md) describe el flujo de negocio vigente.

## Punto de partida

- La consulta pública acepta el número de pedido como único requisito. El servidor excluye los datos del cliente, la entrega y las notas, pero publica artículos, importes y estados. [Ruta pública](../../packages/core/src/astro/routes/api/shop/orders/%5BorderNumber%5D.ts) · [Manejador](../../packages/core/src/api/handlers/shop.ts)
- El checkout y las retenciones son públicos. La revisión estática no encontró límites específicos en esas rutas ni idempotencia persistente para crear pedidos. La concurrencia y el vencimiento de las retenciones quedan por validar. [Checkout](../../packages/core/src/astro/routes/api/shop/orders/index.ts) · [Retenciones](../../packages/core/src/astro/routes/api/shop/reservations/hold.ts)
- Guardar una plantilla actualiza el contenido. El envío manual lee la versión guardada. El checkout no invoca ese envío ni registra una confirmación pendiente, aunque ambas variantes registran Resend. [Plugin de plantillas](../../packages/plugins/email-templates/src/templates.ts) · [Node](../../templates/ecommerce/astro.config.mjs) · [Cloudflare](../../templates/ecommerce-cloudflare/astro.config.mjs)
- Los enlaces llevan a `/seguimiento`, una página con contenido inicial vacío. El formulario está en `/shop/track`. La guía indica copiar un template, pero las dos variantes declaran dependencias `workspace:*`. [Formulario](../../templates/ecommerce/src/pages/shop/track/index.astro) · [Guía actual](../src/content/docs/reference/ecommerce-template.mdx) · [Dependencias de Node](../../templates/ecommerce/package.json) · [Dependencias de Cloudflare](../../templates/ecommerce-cloudflare/package.json)

## Estado de implementación

- El seguimiento usa un token aleatorio por pedido y conserva únicamente su hash para validarlo. La pantalla de confirmación y la API usan respuestas que no se almacenan en caché. Los pedidos creados antes de la migración siguen disponibles desde el admin.
- El checkout requiere una clave de idempotencia, guarda el hash de la solicitud y asocia la clave al pedido dentro de la transacción. Las pruebas cubren reintentos simultáneos y reutilización de clave con datos distintos.
- El checkout limita pedidos a 10 solicitudes por minuto por dirección IP y retenciones a 20 por minuto. Ambas variantes conservan la clave durante los reintentos.
- El checkout envía la plantilla transaccional activa `order-confirmation` si el comprador proporcionó email. El outbox deduplica por pedido. Los tests usan el proveedor local. La entrega real con Resend queda para la prueba Cloudflare en la nube.
- La guía apunta a `/shop/track`, explica la dependencia del monorepo y describe la plantilla de confirmación.

## Tareas para los subagentes

### 1. Seguimiento en el servidor · P1

Definir el contrato de acceso antes de cambiar los templates. Proponer un token aleatorio por pedido, almacenar su huella y entregar el acceso al comprador en la confirmación. Comparar el token en el servidor, hacer explícita la lista de campos públicos y responder con `Cache-Control: no-store`. Limitar intentos y evitar registrar el token en logs. Mantener el historial accesible en el admin. Acordar cómo recuperar acceso para compradores con pedidos anteriores y documentar el cambio de contrato para integraciones existentes.

**Aceptación** — La consulta exige una credencial válida para ese pedido. Las respuestas a credenciales ausentes o inválidas omiten datos del pedido. Un token de otro pedido se rechaza. Los pedidos anteriores siguen accesibles desde el admin. Entregar a las tareas 3 y 4 el contrato, los errores y la forma de compartir el enlace.

### 2. Checkout y retenciones · P1

Aplicar límites de frecuencia en el servidor y acotar las retenciones activas por sesión. Acordar umbrales y un almacenamiento compartido que funcione en los despliegues previstos. Implementar una clave de idempotencia por intento de compra, asociada a la sesión y al contenido de la solicitud. Resolver la duplicación en la base de datos junto con los efectos del pedido. Revisar la validación de stock y cupos bajo concurrencia y el vencimiento de las retenciones.

**Aceptación** — Solicitudes concurrentes con la misma clave y los mismos datos recuperan el mismo pedido y consumen stock o cupos una sola vez. Una clave reutilizada con otros datos produce un conflicto. Ante dos compras distintas por la última unidad, solo una se confirma. Las retenciones vencidas liberan el cupo y las solicitudes por encima del límite reciben una respuesta controlada.

### 3. Confirmación de compra por correo · P2

Registrar el envío pendiente junto con la confirmación del pedido y procesarlo fuera de la respuesta de checkout. Resolver la plantilla de confirmación mediante una configuración explícita. Propuesta para revisión: conservar el asunto y el cuerpo renderizados al encolar, de modo que los pedidos futuros usen la edición guardada y los reintentos conserven el contenido original. Usar el correo del comprador y el mecanismo de entrega configurado para Resend. Registrar intentos y fallos, y deduplicar por pedido y evento. Añadir una política de reintentos que cubra respuestas ambiguas del proveedor.

**Aceptación** — Guardar una edición solo actualiza la plantilla. Una compra posterior envía al comprador un correo con el asunto y el cuerpo actualizados. Un fallo del proveedor conserva el pedido y deja un envío recuperable. Verificar con un proveedor de prueba los reintentos y la deduplicación, y comprobar la recepción en un buzón de staging con Resend.

### 4. Navegación y documentación · P2

Actualizar los dos templates con el contrato de las tareas 1 y 2. Conectar el pie de página y la confirmación con un único formulario de seguimiento. Actualizar la guía con los comandos verificados desde el monorepo, la inicialización y los datos de prueba, la configuración de Resend y la primera compra en Node y Cloudflare. Explicar el requisito de `workspace:*` al copiar el template y revisar la especificación funcional cuando se apruebe el contrato de seguimiento.

**Aceptación** — Desde un checkout limpio, una persona puede seguir la guía, iniciar cada variante y consultar su primer pedido desde la confirmación. La guía explica cómo guardar una plantilla, enviar una prueba y verificar la confirmación automática.

## Coordinación y validación

1. Antes de editar, revisar los cambios locales y los `AGENTS.md` aplicables. Registrar el estado de lint según las instrucciones del repositorio. Para cada defecto, añadir primero una prueba de regresión que falle por el comportamiento observado.
2. Acordar los contratos de seguimiento e idempotencia antes de editar los consumidores. Las tareas 1 y 2 pueden avanzar en paralelo una vez asignados los archivos compartidos. Un responsable integra los cambios en el manejador de pedidos, las rutas y el registro de migraciones. Las migraciones deben ser aditivas y tolerar una ejecución parcial.
3. Empezar la integración del correo después de definir el punto de confirmación idempotente del pedido. La navegación consume el contrato de seguimiento aprobado. Actualizar la guía después de comprobar ambos flujos.
4. Antes de desplegar, compilar ambas variantes y validar un pedido de producto, una reserva, el seguimiento protegido y la recepción del correo. Registrar los comandos ejecutados y los resultados por variante. Durante la auditoría, Corepack no pudo resolver `registry.npmjs.org` para descargar `pnpm@11.9.0`. El arranque, la compilación y la entrega real siguen pendientes de verificación.

## Decisiones para revisión

- Aprobar el cambio del contrato público y elegir la recuperación de acceso para pedidos históricos.
- Fijar límites y almacenamiento de contadores para instalaciones Node y Cloudflare según el volumen esperado.
- Confirmar cómo se selecciona la plantilla de confirmación, qué ocurre si falta y cuánto tiempo se conservan los datos de envíos y reintentos.
