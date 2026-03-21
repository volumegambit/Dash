import { Nav } from '@/components/Nav';
import { Hero } from '@/components/Hero';
import { SecureSandbox } from '@/components/SecureSandbox';
import { DeployAndRun } from '@/components/DeployAndRun';
import { AIProviders } from '@/components/AIProviders';
import { MessagingApps } from '@/components/MessagingApps';
import { UseCases } from '@/components/UseCases';
import { HowItWorks } from '@/components/HowItWorks';
import { FinalCTA } from '@/components/FinalCTA';
import { Footer } from '@/components/Footer';

export default function Home() {
  return (
    <main>
      <Nav />
      <Hero />
      <SecureSandbox />
      <DeployAndRun />
      <AIProviders />
      <MessagingApps />
      <UseCases />
      <HowItWorks />
      <FinalCTA />
      <Footer />
    </main>
  );
}
