import { http } from 'viem';
const customFetchFn = async (url: string | URL | globalThis.Request, init?: RequestInit) => {
  return fetch(url, init);
};
const transport = http('https://eth.public-rpc.com', {
  fetchOptions: {},
  // @ts-ignore
  fetchFn: customFetchFn
});
console.log(transport);
