import { AppScreenshot } from '@/components/AppScreenshot';
import { Community } from '@/components/Community';
import { Features } from '@/components/Features';
import { Footer } from '@/components/Footer';
import { Hero } from '@/components/Hero';
import { HowItWorks } from '@/components/HowItWorks';
import { Nav } from '@/components/Nav';
import { QuickStart } from '@/components/QuickStart';

export default function Home() {
  return (
    <main>
      <Nav />
      <Hero />
      <Features />
      <HowItWorks />
      <AppScreenshot />
      <QuickStart />
      <Community />
      <Footer />
    </main>
  );
}
