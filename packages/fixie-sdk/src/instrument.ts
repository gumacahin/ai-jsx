import { NodeSDK } from '@opentelemetry/sdk-node';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import fastify_instrumentation from '@opentelemetry/instrumentation-fastify';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { BatchLogRecordProcessor, LogRecord, LogRecordProcessor } from '@opentelemetry/sdk-logs';
import { Context, propagation } from '@opentelemetry/api';
import { BatchSpanProcessor, Span } from '@opentelemetry/sdk-trace-base';

function escapeRegExp(value: string) {
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions#escaping
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

const fixieApiUrl = process.env.FIXIE_API_URL ?? 'https://api.fixie.ai';
const fixieApiUrlWithSlash = fixieApiUrl.endsWith('/') ? fixieApiUrl : `${fixieApiUrl}/`;
const fixieApiUrlRegex = new RegExp(`${escapeRegExp(fixieApiUrlWithSlash)}.*`);

class CustomSpanProcessor extends BatchSpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    // Attach any Fixie baggage to the span.
    const baggage = propagation.getBaggage(parentContext);
    baggage?.getAllEntries().forEach(([key, value]) => {
      if (key.startsWith('ai.fixie.')) {
        span.setAttribute(key, value.value);
      }
    });

    super.onStart(span, parentContext);
  }
}

class CustomLogProcessor implements LogRecordProcessor {
  // N.B. Wraps (rather than extends) BatchLogRecordProcessor so that we can access
  // the second argument of `onEmit` to access baggage.
  constructor(private readonly delegated: LogRecordProcessor) {}

  forceFlush(): Promise<void> {
    return this.delegated.forceFlush();
  }
  shutdown(): Promise<void> {
    return this.delegated.shutdown();
  }
  onEmit(logRecord: LogRecord, context?: Context | undefined): void {
    // Attach any Fixie baggage to the log record.
    if (context) {
      const baggage = propagation.getBaggage(context);
      baggage?.getAllEntries().forEach(([key, value]) => {
        if (key.startsWith('ai.fixie.')) {
          logRecord.attributes[key] = value.value;
        }
      });
    }

    this.delegated.onEmit(logRecord);
  }
}

const sdk = new NodeSDK({
  spanProcessor: new CustomSpanProcessor(new OTLPTraceExporter()),
  logRecordProcessor: new CustomLogProcessor(new BatchLogRecordProcessor(new OTLPLogExporter())),
  instrumentations: [
    new HttpInstrumentation(),
    new fastify_instrumentation.FastifyInstrumentation(),
    new FetchInstrumentation({
      propagateTraceHeaderCorsUrls: [fixieApiUrlRegex],
    }),
  ],
  serviceName: 'ai.jsx-fixie-agent',
});

// Add some workarounds for `FetchInstrumentation` assuming we're in the browser.
// See https://github.com/open-telemetry/opentelemetry-js/issues/3413
(globalThis as any).location = {} as any;
(globalThis as any).navigator = {} as any;

try {
  sdk.start();
} catch (error) {
  console.error(error);
}

process.on('beforeExit', async () => {
  await sdk.shutdown();
});
