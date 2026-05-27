import { AIProviders } from '@/components/AIProviders';
import { DeployAndRun } from '@/components/DeployAndRun';
import { Footer } from '@/components/Footer';
import { Hero } from '@/components/Hero';
import { HowItWorks } from '@/components/HowItWorks';
import { Nav } from '@/components/Nav';
import { SecureSandbox } from '@/components/SecureSandbox';

export default function Home() {
  return (
    <main>
      <Nav />
      <Hero />
      <SecureSandbox />
      <DeployAndRun />
      <AIProviders />
      <HowItWorks />
      <Footer />
    </main>
  );
}
