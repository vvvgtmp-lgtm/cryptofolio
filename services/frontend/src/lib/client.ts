import { config } from '../config';
import { ApiClient } from './api';

export const api = new ApiClient(config.apiBaseUrl);
