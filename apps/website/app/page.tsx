import { AIProviders } from '@/components/AIProviders';
import { DeployAndRun } from '@/components/DeployAndRun';
import { FinalCTA } from '@/components/FinalCTA';
import { Footer } from '@/components/Footer';
import { Hero } from '@/components/Hero';
import { HowItWorks } from '@/components/HowItWorks';
import { MessagingApps } from '@/components/MessagingApps';
import { Nav } from '@/components/Nav';
import { SecureSandbox } from '@/components/SecureSandbox';
import { UseCases } from '@/components/UseCases';

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
