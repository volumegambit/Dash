import { AIProviders } from '@/components/AIProviders';
import { DeployAndRun } from '@/components/DeployAndRun';
import { EverydayWork } from '@/components/EverydayWork';
import { Footer } from '@/components/Footer';
import { Hero } from '@/components/Hero';
import { HowItWorks } from '@/components/HowItWorks';
import { Nav } from '@/components/Nav';

export default function Home() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <EverydayWork />
        <DeployAndRun />
        <AIProviders />
        <HowItWorks />
      </main>
      <Footer />
    </>
  );
}
