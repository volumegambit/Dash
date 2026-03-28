'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CheckCircle2, AlertCircle } from 'lucide-react';

type Status = 'idle' | 'loading' | 'success' | 'error' | 'duplicate';

export function WaitlistForm() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus('loading');

    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_WAITLIST_URL ?? 'https://atrium-waitlist.volumegambit.workers.dev'}/api/waitlist`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        }
      );
      const data = await res.json();

      if (res.status === 201) {
        setStatus('success');
        setMessage(data.message);
        setEmail('');
      } else if (res.status === 409) {
        setStatus('duplicate');
        setMessage(data.message);
      } else {
        setStatus('error');
        setMessage(data.message);
      }
    } catch {
      setStatus('error');
      setMessage('Something went wrong. Please try again.');
    }
  }

  if (status === 'success') {
    return (
      <div className="flex items-center gap-2 text-white">
        <CheckCircle2 size={20} />
        <span className="font-semibold">{message}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 w-full max-w-md">
      <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3 w-full">
        <Input
          type="email"
          placeholder="Enter your email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="flex-1"
        />
        <Button
          type="submit"
          variant="cta"
          className="rounded-full whitespace-nowrap"
          disabled={status === 'loading'}
        >
          {status === 'loading' ? 'Joining...' : 'Request Early Access'}
        </Button>
      </form>
      {(status === 'error' || status === 'duplicate') && (
        <p className="flex items-center gap-1.5 text-sm text-white/80">
          <AlertCircle size={14} />
          {message}
        </p>
      )}
    </div>
  );
}
