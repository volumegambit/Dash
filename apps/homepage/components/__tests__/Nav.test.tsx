import { render, screen } from '@testing-library/react'
import { Nav } from '../Nav'

describe('Nav', () => {
  it('renders the Dash wordmark', () => {
    render(<Nav />)
    expect(screen.getByText('Dash')).toBeInTheDocument()
  })

  it('renders Download link', () => {
    render(<Nav />)
    expect(screen.getByRole('link', { name: /download/i })).toBeInTheDocument()
  })

  it('renders Docs link pointing to Mintlify', () => {
    render(<Nav />)
    const docsLink = screen.getByRole('link', { name: /docs/i })
    expect(docsLink).toHaveAttribute('href', 'https://dash-aa8db5b5.mintlify.app/introduction')
  })

  it('renders GitHub link', () => {
    render(<Nav />)
    expect(screen.getByRole('link', { name: /github/i })).toBeInTheDocument()
  })
})
