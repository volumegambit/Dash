import { Brain, Sparkles, Zap } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

const PROVIDERS = [
  {
    gradient: 'linear-gradient(180deg, #D97706, #F59E0B)',
    Icon: Brain,
    name: 'Anthropic',
    description:
      'Claude models — exceptional reasoning, nuanced writing, and reliable tool use for complex tasks.',
    recommended: true,
  },
  {
    gradient: 'linear-gradient(180deg, #4285F4, #34A853 33%, #FBBC05 66%, #EA4335)',
    Icon: Sparkles,
    name: 'Google Gemini',
    description:
      'Gemini models — multimodal intelligence with massive context windows and deep Google integration.',
    recommended: false,
  },
  {
    gradient: 'linear-gradient(180deg, #10A37F, #1A7F5A)',
    Icon: Zap,
    name: 'OpenAI',
    description:
      'GPT models — versatile language models with broad capabilities and a massive ecosystem of integrations.',
    recommended: false,
  },
];

export function AIProviders() {
  return (
    <section className="bg-cream py-[100px] px-8 lg:px-[160px]">
      {/* Header */}
      <div className="flex flex-col items-center gap-4">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[3px] text-brand">
          FLEXIBLE AI
        </span>
        <h2 className="font-outfit text-[32px] lg:text-[48px] font-extrabold text-text-dark tracking-tight text-center">
          Your AI, your choice.
        </h2>
        <p className="text-[18px] text-text-secondary text-center max-w-[600px] leading-relaxed">
          Bring your own API keys — use your existing Anthropic, OpenAI, or Google subscriptions
          directly. No middleman, no markup on tokens. Your keys, your usage, your bill.
        </p>
      </div>

      {/* Cards */}
      <div className="flex flex-col md:flex-row gap-6 pt-10">
        {PROVIDERS.map(({ gradient, Icon, name, description, recommended }) => (
          <Card
            key={name}
            className="bg-white rounded-2xl shadow-sm p-8 flex-1 flex flex-col items-center gap-5"
          >
            <CardHeader>
              <div
                className="w-16 h-16 rounded-2xl flex items-center justify-center"
                style={{ background: gradient }}
              >
                <Icon size={28} color="white" />
              </div>
              <CardTitle className="text-[22px] font-bold text-text-dark">{name}</CardTitle>
              {recommended && (
                <Badge variant="default" size="sm">
                  Recommended
                </Badge>
              )}
              <CardDescription className="text-[15px] text-text-secondary text-center leading-relaxed">
                {description}
              </CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
    </section>
  );
}
